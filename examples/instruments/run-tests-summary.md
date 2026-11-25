---
# A command instrument: it runs run-tests-summary.mjs (beside this file) on your machine,
# with no shell, and answers with what it prints. Obys you trust use it at once; anyone
# else's use waits for you in your console's Waiting for you.
# Copy both files into your profile's instruments folder (~/.obysphere/<profile>/instruments/),
# say which folder holds the project, then check it:
#   node rep.mjs instruments check
name: run-tests-summary
description: Runs my project's tests and says how many passed, and which failed.
kind: command
run: [node, ./run-tests-summary.mjs]   # ./ is the instruments folder
# folder: payments     # where npm test runs: one of your Oby's folders (the first if left out)
timeLimitSec: 300      # stopped after 5 minutes
input:
  filter:
    type: string
    description: Only report the tests whose name has this text.
---
Runs `npm test` in my project and answers with a summary: how many tests passed and
failed, and the names of the ones that failed. The filter only narrows what it reports:
it's compared with test names inside the script and never reaches a command line.
