# Crowi Design System — how to build with it

These are the real, compiled shadcn/ui primitives from **Crowi** (a Markdown team wiki), on Crowi's own theme. Built with **Tailwind CSS v4** + **Radix UI**. Every component is a live React export on `window.CrowiUI` — compose them; don't reimplement them.

## Setup & wrapping
- **No global provider is required.** The theme is plain CSS custom properties defined on `:root` in `styles.css` — they apply as soon as that stylesheet is present. Just render components.
- **Dark mode**: add `class="dark"` to any ancestor; every token flips (a second `:root`-level block under `.dark` redefines them).
- **Tooltip** ships its own internal provider — a `<Tooltip>` works standalone. Only add an outer `<TooltipProvider>` when several tooltips must share hover-skip timing.
- **Compound components compose from sub-parts**, all on `window.CrowiUI`: `Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardAction`/`CardContent`/`CardFooter`; `Dialog` + `DialogTrigger`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter`; `Select` + `SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`; `Tabs` + `TabsList`/`TabsTrigger`/`TabsContent`; `DropdownMenu`, `Popover`, `Sheet`, `AlertDialog`, `Avatar` follow the same `<Root><Trigger/><Content/></Root>` shape. Read each `<Name>.prompt.md` for the exact composition.

## Styling idiom — Tailwind v4 utilities on semantic tokens
Style with **Tailwind utility classes**. For color, always reach for the **semantic design tokens** below (never raw hex) so light/dark and the Crowi brand stay correct. The brand is a teal green — it lives behind `primary`.

| Role | Utilities |
|---|---|
| Page surface / text | `bg-background` · `text-foreground` |
| Card / popover surface | `bg-card` `text-card-foreground` · `bg-popover` `text-popover-foreground` |
| Muted / secondary text | `text-muted-foreground` · `bg-muted` |
| Brand / primary action | `bg-primary` `text-primary-foreground` (teal) |
| Secondary / accent | `bg-secondary` `text-secondary-foreground` · `bg-accent` (hover surface) |
| Danger | `bg-destructive` (red) · `text-destructive` |
| Borders / inputs / focus ring | `border` `border-input` · `ring-ring` |
| Radius | `rounded-md` `rounded-lg` `rounded-xl` |

Prefer the component's own prop API over classes where one exists: `<Button variant size>` (`variant`: default/secondary/outline/ghost/destructive/link; `size`: default/sm/lg/icon…), `<Alert variant>` (default/destructive), `<Badge>`-less. Layout (flex/grid/gap/padding) is ordinary Tailwind.

## Where the truth lives
- `styles.css` `@import`s `_ds_bundle.css`, which carries every compiled utility **and** the `:root`/`.dark` token values — read it before inventing a class or color.
- Per component: `<Name>.d.ts` is the exact prop contract; `<Name>.prompt.md` shows how to compose it.

## iOS / mobile designs — standing guidance
When asked for iOS (or mobile) designs of Crowi, apply these on top of everything above:

- **iOS HIG is the foundation, not a suggestion.** Use standard iOS structure wherever a standard exists: large-title navigation bars, bottom tab bar, grouped lists and standard cells, bottom sheets for secondary actions, a standard search bar, segmented controls, swipe actions. Never invent custom chrome where a standard control exists — the app must age gracefully as Apple evolves its own visuals, so structure and controls stay boringly standard. When unsure whether to customize: don't.
- **Crowi's identity lives in accents, not custom controls.** Use the teal `--primary` exactly where iOS uses tint color: active tab, key actions, links, selection states. Plus initials avatars on teal (the Avatar pattern), clean `bg-background`/`bg-card` surfaces, and generous long-form typography for wiki content. Target feel: "a first-party Apple app that happens to be Crowi-branded" — restraint IS the originality.
- **UX priorities, in order:** reading comfort (wiki pages are long-form Markdown — typography and whitespace matter most), search one thumb-tap away, one-handed navigation, minimal chrome while reading (toolbars may recede on scroll), obvious hierarchy.
- **Component mapping:** Button, Avatar (overlapping initials facepile for presence), Card, Sheet (bottom sheets), Tabs (as segmented control), Input (search field), DropdownMenu (overflow menus), AlertDialog (destructive confirmations). All color via the semantic tokens; respect safe areas (status bar, home indicator); realistic wiki content throughout (page paths like `/dev/onboarding-guide`, real-looking member names), never lorem ipsum.

## One idiomatic example
```tsx
// A settings card — library components for the controls, Tailwind for layout glue.
<Card className="w-[360px]">
  <CardHeader>
    <CardTitle>Page settings</CardTitle>
    <CardDescription>Manage visibility for this wiki page.</CardDescription>
  </CardHeader>
  <CardContent className="flex flex-col gap-3">
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="title">Page title</Label>
      <Input id="title" defaultValue="Getting started with Crowi" />
    </div>
    <div className="flex items-center gap-2">
      <Switch checked={true} onCheckedChange={() => {}} id="notify" />
      <Label htmlFor="notify">Notify watchers on edit</Label>
    </div>
  </CardContent>
  <CardFooter className="justify-end gap-2">
    <Button variant="ghost">Cancel</Button>
    <Button>Save changes</Button>
  </CardFooter>
</Card>
```
Note: `Switch` is controlled-only — always pass `checked` and `onCheckedChange`.
