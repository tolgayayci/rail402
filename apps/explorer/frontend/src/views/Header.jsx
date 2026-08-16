import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Header({ v }) {
  return (
    <div style={css('border:2px solid var(--ink);background:var(--panel);')}>
      <div className="r-hdr-top" style={css('display:flex;justify-content:space-between;align-items:center;padding:12px 18px;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid var(--ink);')}>
        <div style={css('display:flex;align-items:center;justify-content:space-between;gap:10px;')}>
          <div style={css('display:flex;align-items:center;gap:10px;cursor:pointer;')} onClick={v.goFeed}>
            <span style={css('background:var(--acc);color:var(--onacc);font-weight:700;font-size:14px;letter-spacing:.06em;padding:5px 9px;')}>RAIL402</span>
            <span style={css('font-weight:600;font-size:14px;letter-spacing:.14em;')}>EXPLORER</span>
          </div>
          <button className="r-menu-btn" onClick={v.toggleMenu} style={css(`align-items:center;gap:7px;height:34px;box-sizing:border-box;padding:0 12px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;`)}>{v.menuIcon} MENU</button>
        </div>
        <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;')}>
        <input className="r-search" value={v.q} onChange={v.setQ} onKeyDown={v.onSearchKey} placeholder="TX HASH · G… / C… ADDRESS" spellCheck="false" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;padding:0 10px;height:34px;box-sizing:border-box;width:240px;border:1.5px solid ${v.searchBd};background:var(--bg);color:var(--ink);outline:none;`)} />
        <span style={css(`display:inline-flex;align-items:center;gap:7px;border:1.5px solid var(--ink);padding:0 10px;height:34px;box-sizing:border-box;background:var(--acc);color:var(--onacc);font-weight:700;font-family:'JetBrains Mono',monospace;font-size:11px;`)}><span style={css('width:8px;height:8px;background:var(--onacc);animation:blink 1.4s infinite;')}></span>LIVE · {v.lastAgoUp}</span>
        <div style={css('position:relative;')}>
          <button onClick={v.toggleNetMenu} style={css(`display:inline-flex;align-items:center;gap:8px;height:34px;box-sizing:border-box;padding:0 10px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;`)}>
            {v.networkLabel}<span style={css('font-size:8px;color:var(--mut);')}>▼</span>
          </button>
          {v.netMenuOpen ? (
            <div style={css('position:absolute;top:38px;left:0;min-width:100%;border:1.5px solid var(--ink);background:var(--panel);z-index:60;')}>
              {v.netOptions.map((o, i) => (
                <Hov key={i} tag="div" onClick={o.pick} style={css(`display:flex;align-items:center;gap:8px;padding:10px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;cursor:${o.cursor};background:${o.bg};color:${o.fg};opacity:${o.opacity};white-space:nowrap;`)} hover={css(`background:${o.hoverBg};color:${o.hoverFg};`)}>{o.label}{o.soon ? <span style={css('font-size:8px;font-weight:700;letter-spacing:.1em;padding:2px 5px;background:var(--acc);color:var(--onacc);')}>SOON</span> : null}</Hov>
              ))}
            </div>
          ) : null}
        </div>
        </div>
      </div>
      <nav className={v.navClass} style={css('display:flex;')}>
          <button onClick={v.goFeed} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 10px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.navFeedBg};color:${v.navFeedFg};display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;')}><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>FEED</button>
          <button onClick={v.goEco} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 10px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.navEcoBg};color:${v.navEcoFg};display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;')}><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>ECOSYSTEM</button>
          <button onClick={v.goFacs} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 10px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.navFacBg};color:${v.navFacFg};display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;')}><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"></line><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"></line></svg>FACILITATORS</button>
          <button onClick={v.goSellers} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 10px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.navSellBg};color:${v.navSellFg};display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;')}><rect width="20" height="8" x="2" y="2" rx="2"></rect><rect width="20" height="8" x="2" y="14" rx="2"></rect><line x1="6" x2="6.01" y1="6" y2="6"></line><line x1="6" x2="6.01" y1="18" y2="18"></line></svg>SELLERS</button>
          <button onClick={v.goAssets} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 10px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.navAssetBg};color:${v.navAssetFg};display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;border-right:none;`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;')}><circle cx="8" cy="8" r="6"></circle><path d="M18.09 10.37A6 6 0 1 1 10.34 18"></path><path d="M7 6h1v4"></path><path d="m16.71 13.88.7.71-2.82 2.82"></path></svg>ASSETS</button>
        </nav>
    </div>
  );
}
