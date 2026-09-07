# First-run onboarding

What a person sees the first time Dive opens, and how to bring it back.

## Flow

1. **Intro** (`src/video/Intro.tsx`, played by `components/onboarding/IntroScene.tsx`).
   A five-second Remotion composition at 30 fps, 1600×1000, drawn from the
   chrome's own colour tokens. Dive's mark, a sphere of dots, assembles out of
   index-derived scattered points; the wordmark cascades in; a rule and the
   tagline settle; four beats name what the browser is for; the copy clears so
   the start screen can take over with its orb in the same place. Skip, Enter,
   Space and Escape hand over early. Under reduced motion the finished lockup
   is shown as a still for a moment instead.
2. **Start** (`StartScreen.tsx`). The welcome ground (character field, orb,
   glow) and one button, "Start Dive", whose border is a conic sweep on a
   registered custom property (`.start-button` in `styles.css`). The button is
   focused, so Enter is enough.
3. **Profile** (`ProfileStep.tsx`). Names, colours and picks a face for the
   install's own profile through `updateProfile`; nothing is created. Skip keeps
   "Personal".
4. **Workspace** (`WorkspaceStep.tsx`). Renames and colours the Home workspace
   through `updateWorkspace`, with a few one-click names. Skip keeps "Home".
5. **Features** (`FeaturesStep.tsx`). Eight cards, the one-minute tour on
   request, and two choices worth making now: DivePrivacy (preselected on, so
   protection is an explicit opt-in that the flow makes easy) and the default
   browser. "Start browsing" writes the choices and finishes.

The stages and their order live in `store/onboarding.ts`; `Onboarding.tsx`
renders the current one above everything else and opens the flow on its own
when `shouldOnboard` says so.

## The flag

`onboarded` is a preference. `Prefs::default()` sets it false, so a fresh
install runs the flow; `parse_stored` sets it true when a stored file predates
the field, so an upgrade never walks an existing user through setup. Finishing
writes `true`; Settings › About › "Reset Dive…" writes `false` and starts the
flow from the intro without deleting anything.

## Motion guidance

The intro follows the Remotion markup rules (every value a function of
`useCurrentFrame()` through `interpolate()` with clamped ends and explicit
easing; individual `scale` / `translate` properties; no CSS transitions) and
the HyperFrames motion principles (build / breathe / resolve, varied eases and
directions, staggers that read as one beat, exits faster than entrances, a
background that is never empty). Both skill sets are installed under
`.claude/skills/` for anyone editing the animation.
