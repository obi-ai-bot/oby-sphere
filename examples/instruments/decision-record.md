---
# A prompt instrument: your Oby drafts a decision record in your team's format, and
# checks it against the decisions already written down in its folders. Copy this file
# into your profile's instruments folder (~/.obysphere/<profile>/instruments/), then:
#   node rep.mjs instruments check
name: decision-record
description: Drafts a decision record in our team's format, checked against our past decisions.
kind: prompt
input:
  title:
    type: string
    description: The decision in a few words, like "Keep receipts for 7 years".
    required: true
  context:
    type: string
    description: What led to it, and what's at stake.
    required: true
  options:
    type: string
    description: The options that were considered, if any.
  status:
    type: string
    enum: [proposed, accepted, rejected]
    default: proposed
---
Draft a decision record titled {{title}}, with the status {{status}}.

First read the decisions already recorded in the folders you can read (a DECISIONS.md,
or a decisions/ folder) and follow their format exactly. Take the context from
{{context}} and the options from {{options}}; don't add facts beyond them.

If an earlier decision covers the same ground or conflicts with this one, say which,
by its title, before the record. Then give the record only, in Markdown, ready to paste.
