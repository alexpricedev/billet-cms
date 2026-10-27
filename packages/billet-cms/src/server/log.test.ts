import { describe, expect, test } from "bun:test";
import { DEFAULT_SKIP_THROTTLE_MS, throttleSkips } from "./log";

/** A sink that records what it was told, plus a clock the test moves itself. */
const sink = () => {
  const messages: string[] = [];
  let clock = 0;
  const log = throttleSkips((message) => messages.push(message), {
    now: () => clock,
  });
  return {
    messages,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("throttleSkips", () => {
  test("reports a message the first time it is seen", () => {
    const { log, messages } = sink();

    log('slot "home.hero" is missing');

    expect(messages).toEqual(['slot "home.hero" is missing']);
  });

  // The case this exists for: no cms_ tables, five slots, every request.
  test("swallows repeats of the same message inside the window", () => {
    const { log, messages, advance } = sink();

    for (let i = 0; i < 50; i++) {
      log("could not read slot: relation cms_meta does not exist");
      advance(100);
    }

    expect(messages).toHaveLength(1);
  });

  test("reports the same message again once the window has passed", () => {
    const { log, messages, advance } = sink();

    log("still broken");
    advance(DEFAULT_SKIP_THROTTLE_MS);
    log("still broken");

    expect(messages).toHaveLength(2);
  });

  // Throttling by message, not globally: one slot going bad must stay visible
  // while another repeats, which is the whole point.
  test("tracks each distinct message separately", () => {
    const { log, messages } = sink();

    log("slot a failed");
    log("slot a failed");
    log("slot b failed");

    expect(messages).toEqual(["slot a failed", "slot b failed"]);
  });

  // A message can carry a database error, so the key space is not the site's
  // slot count. Unbounded, this would be a slow leak in a long-lived process.
  test("remembers a bounded number of messages", () => {
    const { log, messages, advance } = sink();

    for (let i = 0; i < 300; i++) log(`failure ${i}`);
    const distinct = messages.length;

    // The oldest is forgotten, so it reports again rather than being swallowed
    // forever; the newest is still remembered, so it does not.
    advance(1);
    log("failure 0");
    log("failure 299");

    expect(distinct).toBe(300);
    expect(messages.at(-1)).toBe("failure 0");
    expect(messages).toHaveLength(301);
  });

  test("does not throttle across separate throttles", () => {
    const one = sink();
    const two = sink();

    one.log("shared text");
    two.log("shared text");

    expect(one.messages).toHaveLength(1);
    expect(two.messages).toHaveLength(1);
  });
});
