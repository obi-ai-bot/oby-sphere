// The additions to obi/0.1 this server takes (spec/README.md, "Versions"), as `GET /v0.1/features`
// lists them: each a feature id of spec/schemas/v0.1/common.schema.json.

/** `card_runtime`: a card's `features`, `runtime` and `vendors`; `card_classes`: its `classes`;
 *  `card_topics`: its `topics` (spec/identity.md section 2.3). `follow_up`, `cancel` and
 *  `introduction`: a request's `follows`, the `cancel` reply and the `introduction` request
 *  (spec/protocol.md sections 5.17 to 5.19). `policy_classes`: a policy rule's
 *  `from_classes`/`to_classes` (spec/sphere-api.md section 5). */
export const FEATURES: readonly string[] = ["cancel", "card_classes", "card_runtime", "card_topics", "follow_up", "introduction", "policy_classes"];
