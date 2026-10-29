import { Readable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import tls, { type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SocksClient } from "socks";
import { parseEgressIpResponse, queryEgressIpThroughSocks, requestThroughSocks } from "../src/wechat/SshWeChatClient";

describe("WeChat SOCKS HTTPS transport", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("forces the HTTPS request to use the TLS socket created through SOCKS", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    let directConnectionAttempted = false;
    let requestSocket: unknown;

    const createConnection = vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    const connect = vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      if (options.agent instanceof https.Agent) requestSocket = options.agent.createConnection(options);
      else directConnectionAttempted = true;

      const request = new PassThrough() as unknown as ClientRequest;
      queueMicrotask(() => {
        const response = Readable.from([Buffer.from('{"ok":true}', "utf8")]) as IncomingMessage;
        response.statusCode = 200;
        callback(response);
      });
      return request;
    }) as typeof https.request);

    await expect(requestThroughSocks(1080, { method: "GET", path: "/cgi-bin/token", headers: {} }))
      .resolves.toEqual({ statusCode: 200, body: '{"ok":true}' });
    expect(createConnection).toHaveBeenCalledWith({
      command: "connect",
      proxy: { host: "127.0.0.1", port: 1080, type: 5 },
      destination: { host: "api.weixin.qq.com", port: 443 },
      timeout: 15_000
    });
    expect(connect).toHaveBeenCalledWith({ socket: socksSocket, servername: "api.weixin.qq.com" });
    expect(directConnectionAttempted).toBe(false);
    expect(requestSocket).toBe(secureSocket);
  });

  it("reports the public IP observed through the same SOCKS transport", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    let requestOptions: RequestOptions | undefined;

    const createConnection = vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      requestOptions = options;
      const request = new PassThrough() as unknown as ClientRequest;
      queueMicrotask(() => {
        const response = Readable.from([Buffer.from('{"ip":"203.0.113.8"}', "utf8")]) as IncomingMessage;
        response.statusCode = 200;
        callback(response);
      });
      return request;
    }) as typeof https.request);

    await expect(queryEgressIpThroughSocks(1080)).resolves.toBe("203.0.113.8");
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      proxy: { host: "127.0.0.1", port: 1080, type: 5 },
      destination: { host: "api.ipify.org", port: 443 }
    }));
    expect(requestOptions).toMatchObject({
      hostname: "api.ipify.org",
      path: "/?format=json"
    });
    expect(requestOptions?.headers).toMatchObject({ Host: "api.ipify.org" });
  });

  it("rejects unsuccessful, malformed, and non-IP egress responses", () => {
    expect(() => parseEgressIpResponse({ statusCode: 503, body: "busy" })).toThrow("HTTP 503");
    expect(() => parseEgressIpResponse({ statusCode: 300, body: "redirect" })).toThrow("HTTP 300");
    expect(() => parseEgressIpResponse({ statusCode: 200, body: "not json" })).toThrow("无效 JSON");
    expect(() => parseEgressIpResponse({ statusCode: 200, body: '"not an object"' })).toThrow("有效 IP");
    expect(() => parseEgressIpResponse({ statusCode: 200, body: '{"ip":"not-an-ip"}' })).toThrow("有效 IP");
    expect(parseEgressIpResponse({ statusCode: 200, body: '{"ip":" 2001:db8::1 "}' })).toBe("2001:db8::1");
  });

  it("surfaces a SOCKS-routed HTTPS request error", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation((() => {
      const request = new PassThrough() as unknown as ClientRequest;
      const write = vi.spyOn(request, "write");
      const end = vi.spyOn(request, "end");
      queueMicrotask(() => request.emit("error", new Error("socket reset")));
      queueMicrotask(() => {
        expect(write).toHaveBeenCalledWith(Buffer.from("body"));
        expect(end).toHaveBeenCalledOnce();
      });
      return request;
    }) as typeof https.request);

    await expect(requestThroughSocks(1080, { method: "POST", path: "/draft", headers: {} }, Buffer.from("body"))).rejects.toThrow("socket reset");
  });

  it("rejects an oversized response before it can be accumulated", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as unknown as ClientRequest;
      const destroy = vi.fn((error?: Error) => { request.emit("error", error); return request; });
      Object.assign(request, { destroy, end: vi.fn() });
      const response = new PassThrough() as unknown as IncomingMessage;
      callback(response);
      queueMicrotask(() => response.emit("data", Buffer.alloc(5_000_001)));
      return request;
    }) as typeof https.request);

    await expect(requestThroughSocks(1080, { method: "GET", path: "/large", headers: {} })).rejects.toThrow("响应过大");
  });

  it("accepts a response exactly at the 5 MB limit", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as unknown as ClientRequest;
      const destroy = vi.fn((error?: Error) => { request.emit("error", error); return request; });
      Object.assign(request, { destroy, end: vi.fn() });
      const response = new PassThrough() as unknown as IncomingMessage;
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.alloc(5_000_000));
        response.emit("end");
      });
      return request;
    }) as typeof https.request);

    const response = await requestThroughSocks(1080, { method: "GET", path: "/limit", headers: {} });
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(5_000_000);
  });

  it("destroys a request that reaches the HTTPS timeout", async () => {
    const socksSocket = new PassThrough();
    const secureSocket = new PassThrough() as unknown as TLSSocket;
    vi.spyOn(SocksClient, "createConnection").mockResolvedValue({ socket: socksSocket } as never);
    vi.spyOn(tls, "connect").mockReturnValue(secureSocket);
    vi.spyOn(https, "request").mockImplementation((() => {
      const request = new EventEmitter() as unknown as ClientRequest;
      const destroy = vi.fn((error?: Error) => { request.emit("error", error); return request; });
      Object.assign(request, { destroy, end: vi.fn(() => queueMicrotask(() => request.emit("timeout"))) });
      return request;
    }) as typeof https.request);

    await expect(requestThroughSocks(1080, { method: "GET", path: "/slow", headers: {} })).rejects.toThrow("请求超时");
  });
});
