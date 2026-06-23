---
'@crowi/api': patch
---

Add a side gutter to the shared transactional email layout so the white content
card no longer runs edge-to-edge on mobile. On narrow screens the card
previously touched both screen edges, leaving the copy cramped against the
device frame. The card is now wrapped in a gutter that insets it 16px on each
side, giving the content breathing room. This applies to every HTML email
(invite, password reset, activation, admin-approval-pending, password-changed,
email-change, and the test message) since they all share `layout.mjml`; desktop
rendering is unchanged.
