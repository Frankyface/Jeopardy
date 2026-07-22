/* ============================================================
   Unit tests for the photo-clue security gate (spec Part B, U21).
   Zero npm deps: node:test + node:assert only. validateImageRef is
   pure, so the whole accept/reject matrix runs in Node with no DOM.
   Run from the project root:  node --test
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import Media from "../js/media.js";

const { validateImageRef, MAX_IMAGE_REF_LEN } = Media;

/** Assert a reference is accepted. */
function accepts(ref, label) {
  const res = validateImageRef(ref);
  assert.equal(res.valid, true, `expected ACCEPT for ${label || JSON.stringify(ref)} — got: ${res.error}`);
  assert.equal(res.error, null);
}

/** Assert a reference is rejected with a non-empty error string. */
function rejects(ref, label) {
  const res = validateImageRef(ref);
  assert.equal(res.valid, false, `expected REJECT for ${label || JSON.stringify(ref)}`);
  assert.equal(typeof res.error, "string");
  assert.ok(res.error.length > 0, "reject error should be a non-empty message");
}

/* ============ U21 — accepted references ============ */

test("U21 accepts https / http URLs", () => {
  accepts("https://example.com/reveal.jpg");
  accepts("http://example.com/mystery.png");
  accepts("https://cdn.example.com/a/b/c.jpeg?v=2&x=1#frag");
  // Scheme casing is irrelevant.
  accepts("HTTPS://EXAMPLE.COM/X.JPG");
  accepts("HtTp://example.com/x.gif");
});

test("U21 accepts relative repo paths (no scheme)", () => {
  accepts("images/mystery.jpg");
  accepts("./images/mystery.jpg");
  accepts("../assets/reveal.png");
  accepts("mystery.jpg");
  accepts("images/2024/final.webp?cache=1");
  // A colon AFTER a path separator is not a scheme — still relative.
  accepts("images/a:b.jpg");
});

test("U21 accepts data:image/* URIs including svg+xml", () => {
  accepts("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  accepts("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  accepts("data:image/gif;base64,R0lGODdhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=");
  accepts("data:image/webp;base64,UklGRh4AAABXRUJQ");
  // SVG-as-<img> is inert (spec §10.2): scripts/handlers never execute.
  accepts("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E");
  accepts("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=");
  // MIME casing is normalised before the prefix check.
  accepts("DATA:IMAGE/PNG;base64,iVBORw0KGgo=");
});

/* ============ U21 — rejected references ============ */

test("U21 rejects the javascript: scheme (incl. whitespace/control smuggling)", () => {
  rejects("javascript:alert(1)");
  rejects("JavaScript:alert(document.cookie)");
  // The URL parser strips leading whitespace and internal tabs/newlines, so
  // these all normalise to a javascript: scheme and must be rejected too.
  rejects("  javascript:alert(1)", "leading spaces");
  rejects("\t\njavascript:alert(1)", "leading tab/newline");
  rejects("jav\tascript:alert(1)", "tab inside the scheme");
  rejects("java\nscript:alert(1)", "newline inside the scheme");
});

test("U21 rejects non-image data URIs", () => {
  rejects("data:text/html,<script>alert(1)</script>");
  rejects("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==");
  rejects("data:application/javascript,alert(1)");
  rejects("data:text/plain,hello");
  rejects("data:image", "bare data:image with no slash");
  rejects("data:,foo", "empty media type");
});

test("U21 rejects file: / blob: / other schemes", () => {
  rejects("file:///etc/passwd");
  rejects("blob:https://example.com/uuid");
  rejects("ftp://example.com/x.jpg");
  rejects("vbscript:msgbox(1)");
  rejects("about:blank");
});

test("U21 rejects protocol-relative // references", () => {
  rejects("//evil.example.com/x.jpg");
  rejects("//example.com");
});

test("U21 rejects non-strings and empty", () => {
  for (const junk of [null, undefined, 123, 0, {}, [], true, false, NaN, Symbol()]) {
    rejects(junk, `non-string ${String(junk)}`);
  }
  rejects("", "empty string");
});

test("U21 length cap boundary at MAX_IMAGE_REF_LEN", () => {
  assert.equal(MAX_IMAGE_REF_LEN, 2000000);
  // Build a valid data:image/png reference padded to exactly the cap and one over.
  const prefix = "data:image/png;base64,";
  const atCap = prefix + "A".repeat(MAX_IMAGE_REF_LEN - prefix.length);
  assert.equal(atCap.length, MAX_IMAGE_REF_LEN);
  accepts(atCap, "exactly at the length cap");

  const overCap = atCap + "A";
  assert.equal(overCap.length, MAX_IMAGE_REF_LEN + 1);
  rejects(overCap, "one over the length cap");

  // A relative path exactly at the cap is fine; one char over is rejected.
  accepts("a".repeat(MAX_IMAGE_REF_LEN), "relative path at the cap");
  rejects("a".repeat(MAX_IMAGE_REF_LEN + 1), "relative path over the cap");
});
