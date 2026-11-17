/** Review comes with agentbox, as an extension like any other: its page is the cards sessions hand you (src/core/cards.ts). */
import { type Plugin, Icon } from "agentbox/client";
import { Review } from "./Review";

export default function review(p: Plugin) {
  p.page({
    id: "review",
    label: "Review",
    icon: Icon.cards,
    scoped: true,
    flush: true,
    // Only what waits on your word, kept for later or not: notes and merges keep.
    badge: (state) => state.cards.filter((c) => c.kind === "decision" && (c.state === "open" || c.state === "later")).length,
    badgeTitle: (n) => `${n} decision${n === 1 ? "" : "s"} waiting on you`,
    keys: [
      ["→", "Answer the card"],
      ["↓", "Approve it"],
      ["←", "Later"],
      ["x", "Dismiss a decision"],
      ["↑", "Read it whole"],
      ["u", "Undo"],
    ],
    render: ({ state, rest }) => <Review state={state} rest={rest} />,
  });
}
