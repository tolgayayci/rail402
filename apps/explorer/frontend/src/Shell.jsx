import React from 'react';
import { css } from './lib/css.js';
import Header from './views/Header.jsx';
import Feed from './views/Feed.jsx';
import Facilitators from './views/Facilitators.jsx';
import FacilitatorDetail from './views/FacilitatorDetail.jsx';
import Tx from './views/Tx.jsx';
import Address from './views/Address.jsx';
import Ecosystem from './views/Ecosystem.jsx';
import Sellers from './views/Sellers.jsx';
import Assets from './views/Assets.jsx';
import AssetDetail from './views/AssetDetail.jsx';
import FooterBits from './views/FooterBits.jsx';

/** Page shell: the design's two wrapper divs, the header, one active route view, footer. */
export default function Shell({ v }) {
  return (
    <div style={css("min-height:100vh;background:var(--bg);color:var(--ink);font-family:'Space Grotesk',sans-serif;")}>
      <div className="r-wrap" style={css('max-width:1280px;margin:0 auto;padding:20px 24px 48px;')}>
        <Header v={v} />
        {v.routeFeed ? <Feed v={v} /> : null}
        {v.routeFacs ? <Facilitators v={v} /> : null}
        {v.routeFac ? <FacilitatorDetail v={v} /> : null}
        {v.routeTx ? <Tx v={v} /> : null}
        {v.routeAddr ? <Address v={v} /> : null}
        {v.routeEco ? <Ecosystem v={v} /> : null}
        {v.routeSellers ? <Sellers v={v} /> : null}
        {v.routeAssets ? <Assets v={v} /> : null}
        {v.routeAsset ? <AssetDetail v={v} /> : null}
        <FooterBits v={v} />
      </div>
    </div>
  );
}
