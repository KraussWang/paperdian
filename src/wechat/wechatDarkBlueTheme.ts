/*
 * Paper Reading dark-blue theme.
 * Designed for business analysis, data reviews, and research-heavy articles.
 */
export const WECHAT_DARK_BLUE_CSS = String.raw`
body {
  margin: 0;
  padding: 14px 20px;
  color: #3f3f3f;
  background: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 1.72;
  letter-spacing: 0.006em;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  text-align: left;
}
#output { max-width: 677px; margin: 0 auto; }
.container { max-width: 100%; }
p { margin: 0 0 18px; color: #3f3f3f; font-size: 15px; line-height: 1.72; text-align: left; }
.paperdian-paper-info { display: block; margin: 0 0 25px; padding: 14px 16px; border-left: 4px solid #a84317; color: #536a84; background: #edf3f8; font-size: 13px; line-height: 1.7; }
.paperdian-paper-info span { display: block; }
h1, h2, h3, h4, h5, h6 { padding: 0; text-align: left; }
h1 { margin: 18px 0 34px; padding: 27px 24px 25px; border: 0; color: #ffffff; background: #102b4e; font-size: 29px; font-weight: 800; line-height: 1.38; letter-spacing: 0.015em; }
h2 { margin: 42px 0 20px; padding: 0 0 7px; border-bottom: 2px solid #173f7a; color: #173f7a; background: transparent; font-family: "SFMono-Regular", Consolas, monospace; font-size: 18px; font-weight: 700; line-height: 1.45; }
h3 { display: table; margin: 29px 0 14px; padding: 4px 8px; border: 1px solid #7790ac; color: #173f7a; background: #edf3f8; font-family: "SFMono-Regular", Consolas, monospace; font-size: 14px; font-weight: 700; line-height: 1.5; }
h4, h5, h6 { margin: 28px 0 13px; color: #365777; font-size: 16px; font-weight: 700; }
blockquote { margin: 26px 0; padding: 15px 4px; border: 0; border-top: 1px dashed #7790ac; border-bottom: 1px dashed #7790ac; color: #314765; background: transparent; font-family: "SFMono-Regular", Consolas, monospace; font-size: 14px; line-height: 1.7; }
blockquote p { margin: 0; color: #314765; font-family: inherit; font-size: inherit; line-height: inherit; }
blockquote blockquote { margin: 10px 0 0; padding: 8px 0 0 12px; border-top: 1px dotted #aebdce; border-bottom: 0; }
ul, ol { margin: 18px 0 24px; padding-left: 25px; color: #a84317; }
ul { list-style-type: square; }
ol { font-family: "SFMono-Regular", Consolas, monospace; list-style-type: decimal-leading-zero; }
li { margin: 6px 0; color: #3f3f3f; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.68; }
ol > li { padding: 3px 0 9px; border-bottom: 1px dotted #aebdce; }
a { color: #175da8; font-weight: 600; text-decoration: underline; text-decoration-color: #8bb4df; text-underline-offset: 0.2em; }
strong { color: #142e55; font-weight: 750; }
em { font-style: italic; }
mark { padding: 1px 4px; color: #633018; background: #f9d9c8; }
hr { height: 0; margin: 38px 0; border: 0; border-top: 1px dashed #7790ac; background: transparent; }
img { display: block; max-width: 100%; height: auto; margin: 30px auto 36px; padding: 5px; border: 1px solid #aebdce; background: #ffffff; }
pre { margin: 30px 0; padding: 0; overflow-x: auto; border: 1px solid #173f7a; border-top: 6px solid #a84317; background: #13233a; }
pre code { display: block; min-width: max-content; padding: 19px 20px; color: #eaf1f8; background: #13233a; font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; line-height: 1.7; white-space: pre; }
code { font-family: "SFMono-Regular", Consolas, monospace; }
:not(pre) > code { padding: 2px 6px; border: 1px solid #c7d2df; color: #174f8f; background: #eef3f8; font-size: 13px; }
table { width: 100%; margin: 32px 0; border-collapse: collapse; border: 2px solid #173f7a; color: #26354d; background: #ffffff; font-variant-numeric: tabular-nums; text-align: left; }
th, td { min-width: 88px; padding: 11px 10px; border: 1px solid #c9d4e0; font-size: 14px; line-height: 1.6; }
th { color: #ffffff; background: #173f7a; font-weight: 700; }
tr:nth-child(2n) { background: #f0f4f8; }
.paperdian-math.is-display { display: block; margin: 30px 0; padding: 18px 10px; overflow-x: auto; border: 1px solid #c9d4e0; background: #f7f9fb; text-align: center; }
.paperdian-math:not(.is-display) { vertical-align: middle; }
input[type="checkbox"] { accent-color: #173f7a; pointer-events: none; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-type { color: #ff7b72; }
.hljs-title, .hljs-title.class_, .hljs-title.function_ { color: #d2a8ff; }
.hljs-attr, .hljs-attribute, .hljs-number, .hljs-variable { color: #79c0ff; }
.hljs-regexp, .hljs-string { color: #a5d6ff; }
.hljs-built_in, .hljs-symbol { color: #ffa657; }
.hljs-comment, .hljs-code, .hljs-formula { color: #9198a1; }
.hljs-name, .hljs-quote, .hljs-selector-tag { color: #7ee787; }
`;
