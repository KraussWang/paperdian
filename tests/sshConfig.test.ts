import { describe, expect, it } from "vitest";
import { buildWeChatDraftPayload, validateSshConfig } from "../src/wechat/SshWeChatClient";

describe("SSH configuration", () => {
  it("rejects shell metacharacters and invalid ports before spawning OpenSSH", () => {
    expect(() => validateSshConfig({ host: "host;whoami", user: "deploy", port: 22, privateKeyPath: "C:/key" })).toThrow("主机名");
    expect(() => validateSshConfig({ host: "host", user: "deploy", port: 70000, privateKeyPath: "C:/key" })).toThrow("端口");
    expect(() => validateSshConfig({ host: "host", user: "deploy", port: 22, privateKeyPath: "C:/key\n-o Bad=yes" })).toThrow("私钥路径");
  });

  it("maps empty optional metadata to the WeChat draft payload", () => {
    expect(buildWeChatDraftPayload({
      title: "标题",
      summary: "",
      author: "",
      sourceUrl: "",
      html: "<p>正文</p>",
      coverMediaId: "cover-media",
      needOpenComment: 1,
      onlyFansCanComment: 0
    })).toEqual({
      articles: [{
        title: "标题",
        author: "",
        digest: "",
        content: "<p>正文</p>",
        content_source_url: "",
        thumb_media_id: "cover-media",
        need_open_comment: 1,
        only_fans_can_comment: 0
      }]
    });
  });
});
