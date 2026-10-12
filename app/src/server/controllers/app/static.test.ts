import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createBunRequest } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { forms } from "./forms";
import { stack } from "./stack";

describe("Static Page Controllers", () => {
  beforeEach(async () => {
    await cleanupTestData(connection);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("Stack Controller", () => {
    test("renders stack page", async () => {
      const req = createBunRequest("http://localhost:3000/stack");
      const response = await stack.index(req);
      const html = await response.text();

      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get("content-type")).toBe("text/html");

      expect(html).toContain("The Stack");
    });

    // Husky is gone with the rest of the strip, so the feedback stack lists four
    // layers, not five.
    test("does not advertise pre-commit hooks", async () => {
      const req = createBunRequest("http://localhost:3000/stack");
      const response = await stack.index(req);
      const html = await response.text();

      expect(html).not.toMatch(/pre-commit/i);
      expect(html).toContain("Four layers");
    });
  });

  describe("Forms Controller", () => {
    test("renders forms page", async () => {
      const req = createBunRequest("http://localhost:3000/forms");
      const response = await forms.index(req);
      const html = await response.text();

      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get("content-type")).toBe("text/html");

      expect(html).toContain("Form");
    });
  });
});
