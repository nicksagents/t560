import test from "node:test";
import assert from "node:assert/strict";

import { extractEcommerceCandidates, pickCheapestCandidate } from "../src/agents/ecommerce.ts";

test("extractEcommerceCandidates ranks priced product rows and picks cheapest", () => {
  const outcomes = [
    {
      toolName: "web_search",
      content: JSON.stringify({
        results: [
          {
            title: "Raspberry Pi 5 - 16GB RAM - C$169.99",
            url: "https://www.amazon.ca/dp/B0TESTA",
            description: "Official listing",
          },
          {
            title: "Raspberry Pi 5 16GB - C$149.95",
            url: "https://www.amazon.ca/dp/B0TESTB",
            description: "Bundle listing",
          },
        ],
      }),
    },
    {
      toolName: "browser",
      content: JSON.stringify({
        snapshot: {
          links: [
            {
              text: "Raspberry Pi 5 16GB C$139.99",
              url: "https://www.amazon.ca/dp/B0TESTC",
            },
          ],
        },
      }),
    },
  ];

  const candidates = extractEcommerceCandidates({
    query: "cheapest raspberry pi with 16gb ram",
    outcomes,
    limit: 10,
  });

  assert.ok(candidates.length >= 3);
  assert.equal(candidates[0].url, "https://www.amazon.ca/dp/B0TESTC");
  assert.equal(candidates[0].price?.amount, 139.99);

  const cheapest = pickCheapestCandidate(candidates);
  assert.ok(cheapest);
  assert.equal(cheapest?.url, "https://www.amazon.ca/dp/B0TESTC");
  assert.equal(cheapest?.price?.amount, 139.99);
});
