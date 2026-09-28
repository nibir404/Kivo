import { Bot, ChartLine, Dices, Footprints, Globe, Network, Trophy, Target } from "lucide-react"
import { hasTech } from "../derive"
import { curve, jitter, match, stem, type WorkspaceDef } from "../model"

const ENV = /(^|\/)(envs?|environments?)\/.*\.py$|(^|\/)[^/]*env[^/]*\.py$/
const AGENT = /(^|\/)(agents?|policies|policy)\/.*\.py$|(^|\/)(agent|policy|ppo|dqn|sac|a2c)[^/]*\.py$/

export const rl: WorkspaceDef = {
  id: "rl",
  label: "Reinforcement Learning",
  icon: Bot,
  hue: 330,
  tagline: "An agent, a world, a reward — and whether it learns the behaviour you meant.",
  primaryMode: "Train",
  hero: { title: "What should the agent learn to do?", body: "Describe the environment, what the agent can do, and what counts as success. Kivo plans the spaces, the reward and the training setup." },
  placeholder: "e.g. Teach an agent to balance a pole on a cart, and stop training once it holds for 500 steps",
  examples: [
    { icon: Globe, label: "Custom environment", text: "Create a Gymnasium environment for a warehouse robot that picks up and delivers boxes: define the observation space, action space and termination rules." },
    { icon: Trophy, label: "Shape the reward", text: "Design a reward for a delivery robot that finishes quickly without collisions. How do I avoid reward hacking?" },
    { icon: ChartLine, label: "Train with PPO", text: "Train a PPO agent with Stable-Baselines3 on CartPole-v1, log episode reward, and evaluate over 20 seeds." },
  ],
  looksFor: ["gymnasium or stable-baselines3 in requirements", "env*.py, envs/", "agent / policy modules"],
  relevant: (tech) => tech === "Gymnasium" || tech === "Stable-Baselines3",
  stats: (ctx) => [
    { label: "Environments", value: String(match(ctx.files, ENV).length) },
    { label: "Agents", value: String(match(ctx.files, AGENT).length) },
    { label: "Gymnasium", value: hasTech(ctx, "Gymnasium") ? "detected" : "—" },
    { label: "SB3", value: hasTech(ctx, "Stable-Baselines3") ? "detected" : "—" },
  ],
  sections: [
    {
      id: "environment",
      label: "Environment",
      icon: Globe,
      blurb: "The world the agent acts in: what it sees, what it can do, when an episode ends.",
      setup: "Design a Gymnasium environment for this project: observation space, action space, reward, and termination/truncation rules.",
      build: (ctx) => {
        const files = match(ctx.files, ENV)
        if (files.length) return { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "name", label: "Environment" }, { key: "file", label: "File", mono: true }], rows: files.map((f) => ({ name: stem(f), file: { text: f, mono: true } })) }] }
        return {
          source: "example",
          note: "No environments yet. Example: CartPole-v1.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "k", label: "" },
                { key: "v", label: "CartPole-v1", mono: true },
              ],
              rows: [
                { k: "Observation", v: "Box(4): cart position, velocity, pole angle, angular velocity" },
                { k: "Actions", v: "Discrete(2): push left, push right" },
                { k: "Reward", v: "+1 for every step the pole stays up" },
                { k: "Terminates", v: "pole angle > 12° or cart leaves the track" },
                { k: "Truncates", v: "after 500 steps" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "agent",
      label: "Agent",
      icon: Bot,
      blurb: "The algorithm and the hyper-parameters that matter most.",
      build: (ctx) => {
        const files = match(ctx.files, AGENT)
        return {
          source: files.length ? "project" : "example",
          evidence: files,
          count: files.length || undefined,
          note: files.length ? undefined : "Example PPO configuration.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "k", label: "Setting", mono: true },
                { key: "v", label: "Value", mono: true, align: "right" },
                { key: "why", label: "Why it matters" },
              ],
              rows: [
                { k: "algorithm", v: "PPO", why: "Stable default for discrete and continuous actions" },
                { k: "learning_rate", v: "3e-4", why: "Too high and the policy collapses" },
                { k: "n_steps", v: "2048", why: "Experience collected before each update" },
                { k: "gamma", v: "0.99", why: "How far ahead the agent plans" },
                { k: "ent_coef", v: "0.01", why: "Keeps it exploring early on" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "policy",
      label: "Policy network",
      icon: Network,
      blurb: "The network that maps observations to actions.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "table",
            columns: [
              { key: "layer", label: "Layer", mono: true },
              { key: "shape", label: "Shape", mono: true },
              { key: "act", label: "Activation" },
            ],
            rows: [
              { layer: "input", shape: "4", act: "—" },
              { layer: "shared_1", shape: "64", act: "tanh" },
              { layer: "shared_2", shape: "64", act: "tanh" },
              { layer: "policy_head", shape: "2", act: "softmax" },
              { layer: "value_head", shape: "1", act: "—" },
            ],
          },
        ],
      }),
    },
    {
      id: "reward",
      label: "Reward",
      icon: Trophy,
      blurb: "What the agent is paid for. Most RL bugs start here.",
      build: () => ({
        source: "example",
        note: "Watch each term on its own: if one dominates, the agent optimises that and ignores the rest.",
        panels: [
          {
            kind: "table",
            columns: [
              { key: "term", label: "Term" },
              { key: "weight", label: "Weight", mono: true, align: "right" },
              { key: "risk", label: "Hacking risk" },
            ],
            rows: [
              { term: "Delivered a box", weight: "+10", risk: { text: "low", tone: "good" } },
              { term: "Per step taken", weight: "-0.01", risk: { text: "may learn to end episodes early", tone: "warn" } },
              { term: "Collision", weight: "-5", risk: { text: "may learn to stand still", tone: "warn" } },
            ],
          },
        ],
      }),
    },
    {
      id: "episodes",
      label: "Episodes",
      icon: Footprints,
      blurb: "Episode reward over training — the headline learning curve.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "Timesteps", value: "180k / 250k" },
              { label: "Mean reward (last 100)", value: "462", tone: "good" },
              { label: "Mean length", value: "471 steps" },
            ],
            charts: [{ title: "Mean episode reward", x: "×1k steps", series: [{ name: "reward", points: curve("rl-reward", 36, 20, 480, 0.04, 2.5).map((v) => Math.min(500, v)) }], target: { value: 475, label: "Solved at 475" } }],
          },
        ],
      }),
    },
    {
      id: "training",
      label: "Training health",
      icon: ChartLine,
      blurb: "Losses and entropy — early warnings of a collapsing policy.",
      build: () => ({
        source: "example",
        note: "Entropy should fall gradually. A sudden drop to zero means the policy stopped exploring.",
        panels: [
          {
            kind: "metrics",
            tiles: [],
            charts: [
              { title: "Policy entropy", x: "update", series: [{ name: "entropy", points: curve("rl-ent", 36, 0.69, 0.18, 0.02, 2) }] },
              { title: "Value loss", x: "update", series: [{ name: "value loss", points: curve("rl-vl", 36, 48, 6, 0.05, 3) }] },
            ],
          },
        ],
      }),
    },
    {
      id: "evaluation",
      label: "Evaluation",
      icon: Target,
      blurb: "The trained policy on fresh seeds, with exploration switched off.",
      build: () => {
        const scores = jitter("rl-eval", 10, 490, 12).map((v) => Math.round(Math.min(500, v)))
        return {
          source: "example",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "seed", label: "Seed", mono: true },
                { key: "reward", label: "Reward", align: "right" },
                { key: "result", label: "Result" },
              ],
              rows: scores.map((s, i) => ({ seed: 1000 + i, reward: s, result: s >= 475 ? { text: "solved", tone: "good" } : { text: "fell", tone: "warn" } })),
            },
          ],
        }
      },
    },
    {
      id: "checklist",
      label: "Sanity checks",
      icon: Dices,
      blurb: "Checks that catch most broken RL setups.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "random", title: "A random agent's score is recorded as the baseline" },
              { id: "check_env", title: "gymnasium.utils.env_checker passes on the environment" },
              { id: "seeds", title: "Results hold across at least 5 seeds" },
              { id: "norm", title: "Observations and rewards are normalised" },
              { id: "watch", title: "Someone watched rollouts — the behaviour is what you meant" },
              { id: "trunc", title: "Truncation (time limit) is handled separately from termination" },
            ],
          },
        ],
      }),
    },
  ],
}
