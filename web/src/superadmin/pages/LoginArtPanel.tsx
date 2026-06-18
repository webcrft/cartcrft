/**
 * LoginArtPanel — the right-hand artwork for the operator console split-screen.
 *
 * Deliberate aesthetic: dark steel-graphite, restrained technical motifs.
 * Hand-authored SVG + CSS only; no external images. Respects prefers-reduced-motion.
 */

import React from 'react'
import './LoginArtPanel.css'

export default function LoginArtPanel() {
  return (
    <div className="lp-panel" aria-hidden="true">
      {/* === Base scanline + grain texture === */}
      <div className="lp-scanlines" />
      <div className="lp-grain" />

      {/* === Fine technical grid === */}
      <svg className="lp-grid" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <defs>
          <pattern id="lp-minor-grid" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,0.028)" strokeWidth="0.5" />
          </pattern>
          <pattern id="lp-major-grid" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
            <rect width="120" height="120" fill="url(#lp-minor-grid)" />
            <path d="M 120 0 L 0 0 0 120" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.75" />
          </pattern>
          <radialGradient id="lp-grid-mask" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="white" stopOpacity="0.9" />
            <stop offset="100%" stopColor="white" stopOpacity="0.08" />
          </radialGradient>
          <mask id="lp-grid-fade">
            <rect width="100%" height="100%" fill="url(#lp-grid-mask)" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="url(#lp-major-grid)" mask="url(#lp-grid-fade)" />
      </svg>

      {/* === Content container === */}
      <div className="lp-content">

        {/* === CartCrft wordmark === */}
        <div className="lp-brand">
          <svg className="lp-mark" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Hexagonal operator mark */}
            <polygon
              points="18,2 32,10 32,26 18,34 4,26 4,10"
              fill="none"
              stroke="rgba(181,255,46,0.35)"
              strokeWidth="1"
            />
            <polygon
              points="18,7 28,13 28,25 18,31 8,25 8,13"
              fill="none"
              stroke="rgba(181,255,46,0.18)"
              strokeWidth="0.75"
            />
            {/* Inner lock shackle + body */}
            <rect x="13" y="19" width="10" height="8" rx="1.5"
              fill="none" stroke="rgba(181,255,46,0.75)" strokeWidth="1.25" />
            <path d="M14.5 19v-3.5a3.5 3.5 0 0 1 7 0V19"
              fill="none" stroke="rgba(181,255,46,0.75)" strokeWidth="1.25"
              strokeLinecap="round" />
            <circle cx="18" cy="23.5" r="1.25" fill="#b5ff2e" opacity="0.9" />
          </svg>
          <span className="lp-wordmark">
            cart<span className="lp-wordmark-lime">crft</span>
          </span>
        </div>

        {/* === Concentric security rings / topographic motif === */}
        <div className="lp-rings-wrap">
          <svg className="lp-rings" viewBox="0 0 320 320" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="lp-ring-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#b5ff2e" stopOpacity="0.07" />
                <stop offset="100%" stopColor="#b5ff2e" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="160" cy="160" r="155" stroke="rgba(255,255,255,0.04)" strokeWidth="0.75" />
            <circle cx="160" cy="160" r="132" stroke="rgba(255,255,255,0.055)" strokeWidth="0.75" />
            <circle cx="160" cy="160" r="109" stroke="rgba(255,255,255,0.07)" strokeWidth="0.75" />
            <circle cx="160" cy="160" r="86" stroke="rgba(255,255,255,0.08)" strokeWidth="0.75" />
            <circle cx="160" cy="160" r="63" stroke="rgba(181,255,46,0.12)" strokeWidth="1" />
            <circle cx="160" cy="160" r="40" stroke="rgba(181,255,46,0.2)" strokeWidth="1" />
            <circle cx="160" cy="160" r="17" fill="rgba(181,255,46,0.06)" stroke="rgba(181,255,46,0.4)" strokeWidth="1" />
            {/* Crosshair tick marks */}
            {[0, 90, 180, 270].map(angle => {
              const rad = (angle * Math.PI) / 180
              const x1 = 160 + Math.cos(rad) * 64
              const y1 = 160 + Math.sin(rad) * 64
              const x2 = 160 + Math.cos(rad) * 76
              const y2 = 160 + Math.sin(rad) * 76
              return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(181,255,46,0.4)" strokeWidth="1.5" strokeLinecap="round" />
            })}
            {/* Diagonal ticks at 45° */}
            {[45, 135, 225, 315].map(angle => {
              const rad = (angle * Math.PI) / 180
              const x1 = 160 + Math.cos(rad) * 87
              const y1 = 160 + Math.sin(rad) * 87
              const x2 = 160 + Math.cos(rad) * 96
              const y2 = 160 + Math.sin(rad) * 96
              return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(255,255,255,0.15)" strokeWidth="0.75" strokeLinecap="round" />
            })}
            {/* Lime glow fill */}
            <circle cx="160" cy="160" r="155" fill="url(#lp-ring-glow)" />
            {/* Rotating sweep line — disabled under reduced-motion via CSS */}
            <line className="lp-sweep" x1="160" y1="160" x2="160" y2="5"
              stroke="rgba(181,255,46,0.15)" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </div>

        {/* === Audit log ticker === */}
        <div className="lp-ticker-wrap">
          <div className="lp-ticker-label">Audit stream</div>
          <div className="lp-ticker">
            <div className="lp-ticker-inner">
              <span className="lp-tick lp-tick--ok">    ✓ AUTH&nbsp;&nbsp;operator login from 10.0.0.1</span>
              <span className="lp-tick lp-tick--info">   — READ&nbsp;&nbsp;/orgs list 200ms</span>
              <span className="lp-tick lp-tick--warn">   ⚑ FLAG&nbsp;&nbsp;store suspended org=b2c1</span>
              <span className="lp-tick lp-tick--ok">    ✓ AUTH&nbsp;&nbsp;session refreshed</span>
              <span className="lp-tick lp-tick--info">   — READ&nbsp;&nbsp;/audit-log cursor=4420</span>
              <span className="lp-tick lp-tick--ok">    ✓ AUTH&nbsp;&nbsp;operator login from 10.0.0.1</span>
              <span className="lp-tick lp-tick--info">   — READ&nbsp;&nbsp;/orgs list 200ms</span>
              <span className="lp-tick lp-tick--warn">   ⚑ FLAG&nbsp;&nbsp;store suspended org=b2c1</span>
            </div>
          </div>
        </div>

        {/* === Bottom badge === */}
        <div className="lp-badge">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="lp-badge-icon">
            <circle cx="5" cy="5" r="4.25" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
            <circle cx="5" cy="5" r="1.5" fill="currentColor" opacity="0.7" />
          </svg>
          Operator console&nbsp;&nbsp;·&nbsp;&nbsp;Access logged
        </div>
      </div>
    </div>
  )
}
