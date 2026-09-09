---
'@crowi/web': patch
---

Give the page-history screen more room and make its diff readable on a phone. The card frame around the screen body is gone, so the revision table and the diff now use the full width the full-bleed layout already gave them; the table and the diff keep their own borders as the frames that delimit content. Below 768px the diff always renders unified — side-by-side columns are narrower than any markdown line at that width — and the split/unified control is hidden there instead of offering a mode that cannot be read. A wider viewport keeps the control and still defaults to split view.
