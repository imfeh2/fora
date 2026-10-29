import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";

async function installThread(page: Page) {
  const members = [
    { id: 1, name: "Reader", type: "human", state: "idle" },
    { id: 2, name: "Writer", type: "agent", state: "paused" },
  ];
  const messages = Array.from({ length: 350 }, (_, index) => {
    const id = index + 1;
    let body = `Message ${id}. Short line.`;
    if (id % 9 === 0)
      body += `\n\n${"A paragraph with several lines that requires a larger measurement. ".repeat(12)}`;
    if (id <= 325 && id % 7 === 0)
      body += `\n\n${"Long discussion paragraph with **emphasis** and wrapping content. ".repeat(20)}`;
    if (id <= 325 && id % 5 === 0)
      body += "\n\n```text\nline one\nline two\nline three\n```";
    if (id <= 325 && id % 3 === 0)
      body += `\n\n![Fixture image](/library/fixture-${id}.png)`;
    return {
      id,
      body,
      sender_id: id % 4 === 0 ? 2 : 1,
      sender_name: id % 4 === 0 ? "Writer" : "Reader",
      created_at: "2026-10-26T10:00:00Z",
      mentions: [],
      attachments: [],
    };
  });
  let readThrough = 0;
  let socket: WebSocketRoute;
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      let result: unknown;
      switch (method) {
        case "organization.get":
          result = {
            id: 1,
            uuid: "thread-fixture",
            members,
            human_id: 1,
            token_limit: null,
          };
          break;
        case "discussion.list":
          result = [
            {
              id: 1,
              topic: "Thread layout fixture",
              member_ids: [1, 2],
              archived: false,
              unread: messages.length - readThrough,
              mentions: 0,
            },
          ];
          break;
        case "discussion.page": {
          const limit = params.limit ?? 50;
          const selected = params.entry
            ? messages.slice(0, limit)
            : params.before !== undefined
              ? messages
                  .filter((message) => message.id < params.before)
                  .slice(-limit)
              : params.after !== undefined
                ? messages
                    .filter((message) => message.id > params.after)
                    .slice(0, limit)
                : messages.slice(-limit);
          result = {
            id: 1,
            messages: selected,
            read_through: readThrough,
            latest_id: messages.length,
            first_unread_id: params.entry ? 1 : null,
            has_before: selected.length > 0 && selected[0].id > 1,
            has_after:
              selected.length > 0 && selected.at(-1)?.id !== messages.length,
            previous_sender_id:
              selected.length > 0
                ? (messages[selected[0].id - 2]?.sender_id ?? null)
                : null,
            metadata: {
              topic: "Thread layout fixture",
              archived: false,
              members,
            },
          };
          break;
        }
        case "discussion.mark_read":
          readThrough = Math.max(readThrough, params.message_id);
          result = { read_through: readThrough };
          break;
        case "settings.get":
          result = {};
          break;
        case "library.list":
          result = [];
          break;
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
      route.send(JSON.stringify({ type: "response", id, result }));
    });
  });
  await page.route("**/library/content?**", async (route) => {
    if (route.request().url().includes("fixture-351"))
      await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#3267ad"/></svg>',
    });
  });
  return {
    append() {
      const previous = messages[messages.length - 1];
      const id = previous.id + 1;
      messages.push({
        ...previous,
        id,
        body: `Message ${id}.\n\n${"New output with wrapping content. ".repeat(18)}\n\n![Fixture image](/library/fixture-${id}.png)`,
        sender_id: 2,
        sender_name: "Writer",
      });
      socket.send(
        JSON.stringify({ type: "message.created", discussion_id: 1, id }),
      );
    },
    remoteRead(memberId: number) {
      socket.send(
        JSON.stringify({
          type: "discussion.read_updated",
          discussion_id: 1,
          member_id: memberId,
          read_through: messages.length,
        }),
      );
    },
  };
}

async function sampleLayout(page: Page) {
  return page.locator("main ol:not([hidden])").evaluate((list) => {
    const root = list.parentElement;
    if (!root) throw new Error("Scroll container is missing");
    const bounds = root.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll("li[data-index]"), (row) =>
      row.getBoundingClientRect(),
    );
    const gaps = rows.slice(1).flatMap((row, index) => {
      const previous = rows[index];
      return row.bottom > bounds.top && previous.top < bounds.bottom
        ? [row.top - previous.bottom]
        : [];
    });
    const composer = document.querySelector('[aria-label="Message composer"]');
    if (!composer) throw new Error("Message composer is missing");
    return {
      composerGap:
        composer.getBoundingClientRect().top - rows[rows.length - 1].bottom,
      top: root.scrollTop,
      bottomDistance: root.scrollHeight - root.clientHeight - root.scrollTop,
      minimumGap: Math.min(...gaps),
      mounted: rows.length,
    };
  });
}

test("keeps measured messages separate after jumping to latest and returning", async ({
  page,
}) => {
  const fixture = await installThread(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/discussions/1");
  await expect(page.locator("[data-new-divider]")).toBeVisible();
  const latest = page.getByRole("button", {
    name: /Scroll to latest messages/,
  });
  await latest.click();
  await expect(latest).toBeHidden();
  await expect
    .poll(async () => (await sampleLayout(page)).bottomDistance)
    .toBe(0);
  for (let index = 0; index < 6; index++) {
    await page.waitForTimeout(250);
    const layout = await sampleLayout(page);
    expect(layout.minimumGap).toBeGreaterThanOrEqual(-1);
    expect(layout.mounted).toBeLessThan(50);
    expect(layout.bottomDistance).toBe(0);
    expect(layout.composerGap).toBeGreaterThanOrEqual(23);
    expect(layout.composerGap).toBeLessThanOrEqual(25);
  }
  const root = page.locator("main ol:not([hidden])").locator("..");
  const pinned = await sampleLayout(page);
  const row = page.locator('[data-message-id="349"]');
  await page.mouse.move(0, 0);
  await expect(row.locator(".message-copy-float")).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(row.locator(".message-copy-float")).toHaveCSS("opacity", "1");
  expect((await sampleLayout(page)).top).toBe(pinned.top);
  await root.evaluate((element) => {
    element.scrollTop -= 1200;
  });
  await page.waitForTimeout(300);
  const reading = await sampleLayout(page);
  for (const memberId of [1, 2]) {
    fixture.remoteRead(memberId);
    await page.waitForTimeout(300);
    expect((await sampleLayout(page)).top).toBe(reading.top);
  }
  await root.hover();
  await page.mouse.wheel(0, 100000);
  await expect
    .poll(async () => (await sampleLayout(page)).bottomDistance)
    .toBe(0);
  expect((await sampleLayout(page)).minimumGap).toBeGreaterThanOrEqual(-1);
  fixture.append();
  await expect(page.locator('[data-message-id="351"]')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('[data-message-id="351"] img')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(640);
  await expect
    .poll(async () => (await sampleLayout(page)).bottomDistance)
    .toBe(0);
  await page.waitForTimeout(500);
  expect((await sampleLayout(page)).bottomDistance).toBe(0);
  expect((await sampleLayout(page)).minimumGap).toBeGreaterThanOrEqual(-1);
  expect(errors).toEqual([]);
});
