import https from "node:https";
import tls from "node:tls";
import { SocksClient } from "socks";

export interface SocksTarget {
  host: string;
  port: number;
}

export interface SocksHttpsRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
  target: SocksTarget;
}

export interface SocksHttpsResponse {
  statusCode: number;
  body: string;
}

export interface SocksHttpsTransport {
  request(socksPort: number, request: SocksHttpsRequest): Promise<SocksHttpsResponse>;
}

export class NodeSocksHttpsTransport implements SocksHttpsTransport {
  async request(socksPort: number, request: SocksHttpsRequest): Promise<SocksHttpsResponse> {
    const connection = await SocksClient.createConnection({
      command: "connect",
      proxy: { host: "127.0.0.1", port: socksPort, type: 5 },
      destination: request.target,
      timeout: 15_000
    });
    const secureSocket = tls.connect({ socket: connection.socket, servername: request.target.host });
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => secureSocket;
    return new Promise((resolve, reject) => {
      const httpsRequest = https.request({
        hostname: request.target.host,
        method: request.method,
        path: request.path,
        headers: { Host: request.target.host, ...request.headers },
        agent,
        timeout: 30_000
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 5_000_000) httpsRequest.destroy(new Error("微信接口响应过大。"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      httpsRequest.once("error", reject);
      httpsRequest.once("timeout", () => httpsRequest.destroy(new Error("微信接口请求超时。")));
      if (request.body) httpsRequest.write(request.body);
      httpsRequest.end();
    });
  }
}
