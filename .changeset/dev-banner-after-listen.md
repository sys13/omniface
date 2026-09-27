---
'omniface': patch
---

`omniface dev` prints its banner once the server is listening, not as it starts to. A port that is
already taken, or a `--host` this machine does not have, is now one line naming the address and
exit 1, instead of a banner followed by a crash.
