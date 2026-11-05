import { describe, expect, it } from "vitest";
import { ResourcePhotoService, ResourcePhotoError, FetchLike } from "./resourcePhotos";
import { NotFoundError } from "./bookingService";
import { InMemoryStore } from "../store/store";

function storeWithResource(id = "r1") {
  const store = new InMemoryStore();
  store.addResource({ id, name: "Room A", capacity: 1, createdBy: "k1" });
  return store;
}

function okFetch(body = "img", contentType = "image/png"): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });
}

describe("ResourcePhotoService", () => {
  it("downloads and stores a photo for a resource", async () => {
    const svc = new ResourcePhotoService(storeWithResource(), okFetch("PNGDATA"));
    const photo = await svc.setFromUrl("r1", "https://cdn.example.com/a.png");
    expect(photo.contentType).toBe("image/png");
    expect(photo.bytes.toString()).toBe("PNGDATA");
    expect(svc.get("r1").bytes.toString()).toBe("PNGDATA");
  });

  it("rejects an unknown resource", async () => {
    const svc = new ResourcePhotoService(new InMemoryStore(), okFetch());
    await expect(svc.setFromUrl("missing", "https://x/y.png")).rejects.toThrow(ResourcePhotoError);
  });

  it("throws when no photo has been set", () => {
    const svc = new ResourcePhotoService(storeWithResource(), okFetch());
    expect(() => svc.get("r1")).toThrow(NotFoundError);
  });

  it("surfaces a failed download", async () => {
    const svc = new ResourcePhotoService(storeWithResource(), async () => ({
      ok: false, status: 502, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(svc.setFromUrl("r1", "https://x/y.png")).rejects.toThrow(ResourcePhotoError);
  });
});
