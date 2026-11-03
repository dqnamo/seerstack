import { expect, it } from "vitest";
import { seal, unseal } from "../src/seal";

it("round-trips a secret, and only opens with the same salt", async () => {
  const sealed = await seal("phx_secret", "salt");
  expect(sealed).not.toContain("phx_secret");
  expect(await unseal(sealed, "salt")).toBe("phx_secret");
  await expect(unseal(sealed, "other-salt")).rejects.toThrow();
  expect(await seal("phx_secret", "salt")).not.toBe(sealed);
});
