---
"@crowi/api": patch
---

Fix a race in subtree rename where a concurrent duplicate delivery could report a page as failed to move even though the rename succeeded.

When two deliveries of the same rename request raced under load, a member page's fan-out could read its operation record as missing right before the other delivery created it and moved the page, then derive a from/destination path pair that was already the destination on both sides. That mismatched the delivery that actually moved the page and was reported back as a failure, even though the page landed correctly and no data was lost. The fan-out now reads the page before its operation record and reads that record from the primary, so a request racing a concurrent move always sees either the pre-move page or the already-created operation, never a mix of the two (AC-1, AC-2). Retries on the already-moved page still resume from the saved from/to path (AC-5), duplicate requests with a different body are still rejected before fan-out (AC-3), and all three member-key lookups now read from the primary (AC-4).
