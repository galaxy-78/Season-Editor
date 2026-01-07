// src/test/wiz-utils.unit.test.ts
import { describe, it } from "vitest";
import { strict as assert } from "assert";
import {
  deriveIdAndNamespace,
  namespaceToDash,
  buildTemplate,
  splitName,
  sanitizeForWebview,
} from "../lib/wiz-utils";

describe("wiz-utils", () => {
  it("deriveIdAndNamespace: non-portal should enforce prefix", () => {
    const out = deriveIdAndNamespace("component", "nav.admin");
    assert.equal(out.id, "component.nav.admin");
    assert.equal(out.namespace, "nav.admin");
  });

  it("deriveIdAndNamespace: trims and removes leading/trailing dots", () => {
    const out = deriveIdAndNamespace("page", "page..nav.admin.");
    assert.equal(out.id, "page..nav.admin.");
    assert.equal(out.namespace, "nav.admin");
  });

  it("deriveIdAndNamespace: portal keeps id/namespace as-is(trimmed)", () => {
    const out = deriveIdAndNamespace("portal", "  app.main  ");
    assert.equal(out.id, "app.main");
    assert.equal(out.namespace, "app.main");
  });

  it("namespaceToDash: dot namespace => dash", () => {
    assert.equal(namespaceToDash("nav.admin"), "nav-admin");
    assert.equal(namespaceToDash("..nav..admin.."), "nav-admin");
    assert.equal(namespaceToDash(""), "");
  });

  it("buildTemplate: non-portal", () => {
    const t = buildTemplate("layout", "nav.admin", "/any/path");
    assert.equal(t, "wiz-layout-nav-admin()");
  });

  it("buildTemplate: portal includes appName from portal/<app>", () => {
    const t = buildTemplate("portal", "nav.admin", "/x/portal/app1/src");
    assert.equal(t, "wiz-portal-app1-nav-admin()");
  });

  it("buildTemplate: portal throws if not under portal/<app>", () => {
    assert.throws(() => buildTemplate("portal", "nav", "/x/notportal/app1"));
  });

  it("splitName: handles ext and no ext", () => {
    assert.deepEqual(splitName("hello.txt"), { base: "hello", ext: ".txt" });
    assert.deepEqual(splitName("Makefile"), { base: "Makefile", ext: "" });
  });

  it("sanitizeForWebview: escapes U+2028/U+2029 and removes control chars", () => {
    const input = "A\u2028B\u2029C\u0000D\tE\nF";
    const out = sanitizeForWebview(input);
    assert.equal(out.includes("\u2028"), false);
    assert.equal(out.includes("\u2029"), false);
    assert.equal(out.includes("\u0000"), false);
    assert.equal(out.includes("\t"), true);
    assert.equal(out.includes("\n"), true);
  });
});
