/*
 * Paper Reading default/blue theme.
 * Adapted from the MIT-licensed baoyu-md default theme and maintained locally.
 */
export const WECHAT_DEFAULT_CSS = String.raw`
:root { --pr-primary: #0f4c81; --pr-link: #576b95; --pr-text: #3f3f3f; --pr-muted: #f7f7f7; --pr-border: #dfdfdf; }
body { margin: 0; padding: 24px; background: #fff; color: var(--pr-text); font-family: -apple-system-font, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif; font-size: 16px; line-height: 1.75; text-align: left; }
#output { max-width: 860px; margin: 0 auto; }
.container { max-width: 100%; }
h1 { display: table; margin: 0 auto 1em; padding: 0 1em; border-bottom: 2px solid var(--pr-primary); color: var(--pr-text); font-size: 1.2em; font-weight: 700; text-align: center; }
h2 { margin: 1.8em 0 0.8em; padding-left: 0.6em; border-left: 4px solid var(--pr-primary); color: var(--pr-text); font-size: 1.12em; }
h3 { margin: 1.5em 0 0.6em; color: var(--pr-primary); font-size: 1.05em; }
p { margin: 1.25em 8px; color: var(--pr-text); letter-spacing: 0.06em; }
.paperdian-paper-info { display: block; margin: 0.8em 8px 1.4em; color: #666; font-size: 14px; line-height: 1.6; }
.paperdian-paper-info span { display: block; }
strong { color: var(--pr-primary); font-weight: 700; }
em { font-style: italic; }
a { color: var(--pr-link); text-decoration: none; }
blockquote { margin: 1em 0; padding: 0.8em 1em; border-left: 4px solid var(--pr-primary); border-radius: 6px; background: var(--pr-muted); color: var(--pr-text); }
blockquote p { margin: 0; }
ul, ol { margin: 1em 8px; padding-left: 1.6em; }
li { margin: 0.35em 0; }
table { width: 100%; margin: 1em 0; border-collapse: collapse; color: var(--pr-text); }
th, td { padding: 0.35em 0.55em; border: 1px solid var(--pr-border); }
th { background: rgba(0, 0, 0, 0.05); font-weight: 700; }
pre { margin: 1em 8px; padding: 0.9em 1em; overflow-x: auto; border-radius: 8px; background: #f6f8fa; color: #24292e; font-size: 90%; line-height: 1.5; white-space: pre; }
code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; }
:not(pre) > code { padding: 0.15em 0.35em; border-radius: 4px; background: #f3f4f5; color: #c7254e; }
img { display: block; max-width: 100%; height: auto; margin: 1em auto; }
hr { height: 1px; margin: 2em 0; border: 0; background: var(--pr-border); }
.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #d73a49; }
.hljs-string, .hljs-doctag { color: #032f62; }
.hljs-title, .hljs-section, .hljs-built_in { color: #e36209; }
.hljs-comment, .hljs-quote { color: #6a737d; }
.paperdian-math.is-display { margin: 1em 0; padding: 0.6em 1em; overflow-x: auto; text-align: center; }
`;
