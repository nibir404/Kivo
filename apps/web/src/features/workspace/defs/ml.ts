import { Brain, ChartLine, Cpu, Database, FlaskConical, Layers, NotebookPen, Scale, Workflow } from "lucide-react"
import { curve, jitter, match, stem, type SectionData, type WorkspaceDef, type WsContext } from "../model"

const DATASET = /(\.(csv|parquet|jsonl|arrow|tfrecord|feather)$|(^|\/)(data|datasets)\/)/
const TRAIN = /(^|\/)(train|training|finetune|fit)[^/]*\.py$/
const MODEL = /\.(pt|pth|onnx|safetensors|pkl|joblib|h5|keras|gguf)$/
const NOTEBOOK = /\.ipynb$/
const EXPERIMENT = /(^|\/)(mlruns|wandb|runs|experiments)\//

const found = (ctx: WsContext, re: RegExp) => match(ctx.files, re)

/** A file-backed table when files exist, otherwise the labelled example. */
function filesOr(ctx: WsContext, re: RegExp, label: string, example: SectionData): SectionData {
  const files = found(ctx, re)
  if (!files.length) return example
  return { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "name", label }, { key: "file", label: "File", mono: true }], rows: files.map((f) => ({ name: stem(f), file: { text: f, mono: true } })) }] }
}

export const ml: WorkspaceDef = {
  id: "ml",
  label: "AI / ML",
  icon: Brain,
  hue: 275,
  tagline: "Data in, models out — and the evidence that they're any good.",
  primaryMode: "Train",
  hero: { title: "What should the model learn?", body: "Describe the task, the data and what \"good\" means. Kivo plans the dataset, the training run and the evaluation." },
  placeholder: "e.g. Classify support tickets into billing, bug or question, using last year's labelled tickets",
  examples: [
    { icon: FlaskConical, label: "Ticket classifier", text: "Train a text classifier that routes support tickets into billing, bug report or question. Plan the dataset split, a baseline, and the evaluation metrics." },
    { icon: Scale, label: "Evaluate fairly", text: "Design an evaluation for a sign-up fraud model: which metrics, which slices of users to check, and what threshold to ship at." },
    { icon: Workflow, label: "Serve a model", text: "Serve a trained model behind a FastAPI endpoint in this project, with input validation, batching and latency monitoring." },
  ],
  looksFor: ["data/ or *.csv, *.parquet", "train*.py", "*.pt, *.onnx, *.safetensors", "*.ipynb", "PyTorch, TensorFlow, scikit-learn, MLflow, wandb"],
  relevant: (tech, cat) => cat === "AI / ML" && !["Gymnasium", "Stable-Baselines3"].includes(tech),
  stats: (ctx) => [
    { label: "Datasets", value: String(found(ctx, DATASET).length) },
    { label: "Training scripts", value: String(found(ctx, TRAIN).length) },
    { label: "Model files", value: String(found(ctx, MODEL).length) },
    { label: "Notebooks", value: String(found(ctx, NOTEBOOK).length) },
  ],
  sections: [
    {
      id: "datasets",
      label: "Datasets",
      icon: Database,
      blurb: "The data each model learns from, and how it's split.",
      setup: "Plan the dataset for a first model in this project: where the data comes from, labelling, and the train / validation / test split.",
      build: (ctx) =>
        filesOr(ctx, DATASET, "Dataset", {
          source: "example",
          note: "No data files in this project yet.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Dataset" },
                { key: "rows", label: "Rows", align: "right" },
                { key: "split", label: "Train / val / test" },
                { key: "labels", label: "Labels" },
              ],
              rows: [
                { name: "tickets-2025", rows: "48,210", split: "80 / 10 / 10", labels: "billing · bug · question" },
                { name: "tickets-holdout", rows: "2,000", split: "— / — / 100", labels: "same, hand-checked" },
              ],
            },
          ],
        }),
    },
    {
      id: "experiments",
      label: "Experiments",
      icon: FlaskConical,
      blurb: "Every training run, its settings and its result, side by side.",
      setup: "Set up experiment tracking for this project (MLflow or Weights & Biases): what to log for every run and how to compare them.",
      build: (ctx) =>
        filesOr(ctx, EXPERIMENT, "Run", {
          source: "example",
          note: "No experiment tracking yet (mlruns/, wandb/).",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "run", label: "Run", mono: true },
                { key: "model", label: "Model" },
                { key: "lr", label: "Learning rate", mono: true, align: "right" },
                { key: "val", label: "Val F1", align: "right" },
                { key: "state", label: "State" },
              ],
              rows: [
                { run: "run-07", model: "distilbert-base", lr: "3e-5", val: "0.912", state: { text: "best", tone: "good" } },
                { run: "run-06", model: "distilbert-base", lr: "5e-5", val: "0.897", state: { text: "done", tone: "neutral" } },
                { run: "run-05", model: "tf-idf + logistic", lr: "—", val: "0.841", state: { text: "baseline", tone: "info" } },
                { run: "run-08", model: "distilbert-base", lr: "2e-5", val: "—", state: { text: "running", tone: "info" } },
              ],
            },
          ],
        }),
    },
    {
      id: "training",
      label: "Training",
      icon: ChartLine,
      blurb: "Loss curves — where overfitting shows up first.",
      build: (ctx) => {
        const scripts = found(ctx, TRAIN)
        return {
          source: "example",
          evidence: scripts,
          note: scripts.length ? `Training scripts found (${scripts.join(", ")}) — curves appear once a run logs metrics.` : "Example run: validation loss flattening while training loss keeps falling means it's starting to overfit.",
          panels: [
            {
              kind: "metrics",
              tiles: [
                { label: "Epochs", value: "20 / 20" },
                { label: "Train loss", value: "0.14" },
                { label: "Val loss", value: "0.31", tone: "warn", hint: "flat since epoch 14" },
              ],
              charts: [{ title: "Loss", x: "epoch", series: [{ name: "train", points: curve("ml-train", 20, 1.2, 0.12, 0.02) }, { name: "validation", points: curve("ml-val", 20, 1.25, 0.33, 0.025, 4) }] }],
            },
          ],
        }
      },
    },
    {
      id: "models",
      label: "Models",
      icon: Layers,
      blurb: "Trained models, their versions and which one is live.",
      build: (ctx) =>
        filesOr(ctx, MODEL, "Model", {
          source: "example",
          note: "No model files yet.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Model" },
                { key: "version", label: "Version", mono: true },
                { key: "stage", label: "Stage" },
                { key: "metric", label: "Test F1", align: "right" },
              ],
              rows: [
                { name: "ticket-router", version: "v3", stage: { text: "production", tone: "good" }, metric: "0.905" },
                { name: "ticket-router", version: "v4", stage: { text: "staging", tone: "info" }, metric: "0.912" },
              ],
            },
          ],
        }),
    },
    {
      id: "evaluation",
      label: "Evaluation",
      icon: Scale,
      blurb: "How well it works overall, per class, and on the slices that matter.",
      build: () => ({
        source: "example",
        note: "Example evaluation. A model can look good overall and still fail one class.",
        panels: [
          { kind: "metrics", tiles: [{ label: "Precision", value: "0.91" }, { label: "Recall", value: "0.90" }, { label: "F1", value: "0.905", tone: "good" }], charts: [] },
          {
            kind: "table",
            title: "Per class",
            columns: [
              { key: "cls", label: "Class" },
              { key: "p", label: "Precision", align: "right" },
              { key: "r", label: "Recall", align: "right" },
              { key: "n", label: "Support", align: "right" },
            ],
            rows: [
              { cls: "billing", p: "0.95", r: "0.94", n: 812 },
              { cls: "bug", p: "0.90", r: "0.93", n: 704 },
              { cls: "question", p: "0.87", r: { text: "0.81", tone: "warn", sub: "weakest" }, n: 484 },
            ],
          },
        ],
      }),
    },
    {
      id: "gpu",
      label: "Compute",
      icon: Cpu,
      blurb: "GPU utilisation and memory during training.",
      build: () => ({
        source: "example",
        note: "No GPU detected on this machine. Example of a healthy run: utilisation stays high, memory stays flat.",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "GPU", value: "1 × A10G" },
              { label: "Utilisation", value: "87 %", tone: "good" },
              { label: "Memory", value: "18.2 / 24 GB" },
            ],
            charts: [{ title: "GPU utilisation", unit: "%", x: "min", series: [{ name: "utilisation", points: jitter("ml-gpu", 40, 86, 6, 0.03).map((v) => Math.min(100, v)) }] }],
          },
        ],
      }),
    },
    {
      id: "notebooks",
      label: "Notebooks",
      icon: NotebookPen,
      blurb: "Exploration and analysis notebooks.",
      build: (ctx) => filesOr(ctx, NOTEBOOK, "Notebook", { source: "example", note: "No notebooks yet.", panels: [{ kind: "table", columns: [{ key: "name", label: "Notebook" }], rows: [{ name: "01-explore-tickets.ipynb" }, { name: "02-error-analysis.ipynb" }] }] }),
    },
    {
      id: "checklist",
      label: "Ship checklist",
      icon: Workflow,
      blurb: "What to confirm before a model reaches users.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "leak", title: "No test data leaked into training (split by user or time, not row)" },
              { id: "baseline", title: "Beats a simple baseline by a meaningful margin" },
              { id: "slices", title: "Checked on important slices (new users, rare classes, languages)" },
              { id: "repro", title: "The run is reproducible: data version, code commit, seed" },
              { id: "monitor", title: "Input drift and prediction quality are monitored in production" },
              { id: "fallback", title: "There's a fallback when the model is down or unsure" },
            ],
          },
        ],
      }),
    },
  ],
}
