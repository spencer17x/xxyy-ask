export function renderChatPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>XXYY Ask</title>
    <link rel="stylesheet" href="/web-assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web-assets/index.js"></script>
  </body>
</html>`;
}
