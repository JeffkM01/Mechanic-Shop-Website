import express from "express";
import { statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export function serveBuiltFrontend(app, directory) {
  const root = resolve(directory);
  const index = join(root, "index.html");
  try { if (!statSync(index).isFile()) throw new Error(); }
  catch { throw new Error("Build the frontend before setting SERVE_FRONTEND=true."); }

  app.use(express.static(root, {
    index: false, dotfiles: "deny", maxAge: 0,
    setHeaders(res, file) {
      const asset = relative(root, file).split(sep)[0] === "assets";
      res.setHeader("Cache-Control", asset ? "public, max-age=31536000, immutable" : "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }));
  app.use((req, res, next) => {
    let path;
    try { path = decodeURIComponent(req.path); }
    catch { return next(); }
    if (!["GET", "HEAD"].includes(req.method) || !req.get("accept")?.includes("text/html") || !req.accepts("html")
      || extname(path) || /^(?:\/api(?:\/|$)|\/(?:assets|images|fonts|src|node_modules)(?:\/|$)|\/\.)/i.test(path)) return next();
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    return res.sendFile(index, error => { if (error) next(error); });
  });
}
