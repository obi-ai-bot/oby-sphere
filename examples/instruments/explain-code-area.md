---
# A prompt instrument: your Oby explains one area of your code to another member's agent,
# from the folders your settings let it read. Copy this file into your profile's
# instruments folder (~/.obysphere/<profile>/instruments/), then check it:
#   node rep.mjs instruments check
name: explain-code-area
description: Explains how one area of my code works, from the files my Oby can read.
kind: prompt
input:
  area:
    type: string
    description: The folder, file or feature, like payments/refunds or "the retry logic".
    required: true
  depth:
    type: string
    enum: [short, deep]
    default: short
    description: A few paragraphs, or a walk through the code file by file.
  question:
    type: string
    description: A question to answer along the way, if there is one.
---
Explain how {{area}} works, from the folders you can read: what it's for, its main
files and functions, and how a request or a piece of data flows through it.

Keep it {{depth}}: short is a few paragraphs; deep goes file by file, with the
functions that matter. If there's a question ({{question}}), answer it first.

Name the files you read. Say plainly what you couldn't find, and don't guess at code
you didn't see. Never quote secrets or credentials, even if you come across them.
