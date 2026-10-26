// The name a person sees for a plan id. The ids are older than the names and stay as they are
// (Stripe metadata, the lock's plan column, analytics, env names):
//   'pro'       -> Plus  (1 upgraded calendar, $29/yr; the trial is Plus)
//   'unlimited' -> Pro   (10 + unlimited under @name)
//   'teams'     -> Teams
// Anything else (a missing or old value) reads as Plus, the plan every lock defaulted to.
// The page twin is planName in public/components/Pro.js; test/unit/plan-name.test.js keeps them equal.
export function planName(plan) {
    return plan === 'unlimited' ? 'Pro' : plan === 'teams' ? 'Teams' : 'Plus';
}
