import { describe, expect, it } from "vitest";

import { normalizeStoredImagePath, resolveStoredImageAbsolutePath } from "./imageStorage";

describe("operational image storage-key normalization", () => {
  it("keeps canonical relative keys and normalizes a known legacy images path", () => {
    expect(normalizeStoredImagePath("outillage/familles/fraise.png")).toBe("outillage/familles/fraise.png");
    expect(normalizeStoredImagePath("C:\\legacy\\uploads\\images\\machines\\vm10.webp"))
      .toBe("machines/vm10.webp");
    expect(normalizeStoredImagePath("uploads/images/machines/relative.webp"))
      .toBe("machines/relative.webp");
    expect(normalizeStoredImagePath("/UPLOADS/IMAGES/machines/mixed-case.webp"))
      .toBe("machines/mixed-case.webp");
  });

  it("rejects remote, unmarked absolute, UNC, traversal, dot and colon keys", () => {
    expect(normalizeStoredImagePath("https://example.test/uploads/images/public.png")).toBeNull();
    expect(normalizeStoredImagePath("ftp://example.test/uploads/images/public.png")).toBeNull();
    expect(normalizeStoredImagePath("file:///uploads/images/public.png")).toBeNull();
    expect(normalizeStoredImagePath("data:image/png;base64,AAAA")).toBeNull();
    expect(normalizeStoredImagePath("custom:uploads/images/public.png")).toBeNull();
    expect(normalizeStoredImagePath("ftp://example.test/no-marker.png")).toBeNull();
    expect(normalizeStoredImagePath("C:\\legacy\\secret.png")).toBeNull();
    expect(normalizeStoredImagePath("/etc/secret.png")).toBeNull();
    expect(normalizeStoredImagePath("/legacy/uploads/images/foo/uploads/images/nested.png"))
      .toBe("foo/uploads/images/nested.png");
    expect(normalizeStoredImagePath("\\\\server\\legacy\\uploads\\images\\network.png")).toBe("network.png");
    expect(normalizeStoredImagePath("\\\\server\\share\\secret.png")).toBeNull();
    expect(normalizeStoredImagePath("machines/../secret.png")).toBeNull();
    expect(normalizeStoredImagePath("machines/./secret.png")).toBeNull();
    expect(normalizeStoredImagePath("machines/customer:secret.png")).toBeNull();
    expect(normalizeStoredImagePath("uploads/images/../../secret.png")).toBeNull();
    expect(normalizeStoredImagePath("C:\\legacy\\uploads\\images\\..\\..\\secret.png")).toBeNull();
    expect(normalizeStoredImagePath("../uploads/images/secret.png")).toBeNull();
    expect(normalizeStoredImagePath("C:/../uploads/images/secret.png")).toBeNull();
    expect(normalizeStoredImagePath("uploads/images/./secret.png")).toBeNull();
    expect(normalizeStoredImagePath("uploads/images/evil:name.png")).toBeNull();
    expect(normalizeStoredImagePath("images/evil:name.png")).toBeNull();
    expect(normalizeStoredImagePath("uploads/images/evil\u0000name.png")).toBeNull();
    expect(normalizeStoredImagePath("notuploads/images/marker-like.png"))
      .toBe("notuploads/images/marker-like.png");
    expect(normalizeStoredImagePath("path/notuploads/images/marker-like.png"))
      .toBe("path/notuploads/images/marker-like.png");
    expect(normalizeStoredImagePath("uploads//images/doubled-marker.png")).toBeNull();
  });

  it("never resolves a rejected key outside the configured image root", () => {
    expect(resolveStoredImageAbsolutePath("../../secret.png")).toBeNull();
    expect(resolveStoredImageAbsolutePath("C:\\secret.png")).toBeNull();
  });
});
