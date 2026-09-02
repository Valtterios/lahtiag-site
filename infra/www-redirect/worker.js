// Redirects www.lahtiag.fi to the apex. A separate one-file Worker so the
// main site Worker's asset routing stays untouched; deployed manually once:
//   npx wrangler deploy -c infra/www-redirect/wrangler.toml
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'lahtiag.fi';
    return Response.redirect(url.toString(), 301);
  },
};
