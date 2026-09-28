import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { connectDesktop } from './lib/desktop'
import { resolveBackend } from './lib/transport'

// Decide daemon vs in-browser before anything renders: every component reads the result synchronously.
connectDesktop()
void resolveBackend().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
