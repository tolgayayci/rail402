import React from 'react';
import Shell from './Shell.jsx';

/**
 * The explorer's entire application logic, ported VERBATIM from the design prototype
 * (file "Rail402 Explorer.dc.html", script block). DCLogic's contract is
 * React.Component's own (state class field, setState with updater+callback, lifecycle methods),
 * so the base class swap changes nothing. The ONLY deliberate edits, each marked by the
 * extraction script in ../scripts/extract-logic note in README:
 *   1. hash routing (#/tx/..) -> real paths (/tx/..) via pushState/popstate,
 *   2. asset URLs made root-absolute so nested routes resolve them,
 *   3. a render() method composing the view components from renderVals().
 * Do not hand-edit design behavior here; change the design project and re-port.
 */
export default class Logic extends React.Component {
  state = { route: { name: 'feed', arg: null }, network: 'stellar:pubnet',
    stats: null, items: [], loading: true, tier: 'all', scheme: 'all', cursor: null, more: false,
    q: '', searchErr: false,
    facs: null, facsLoading: false, facData: null, facLoading: false, facCursor: null, facMore: false,
    txData: null, txLoading: false, txErr: null, raw: null, rawOpen: false,
    addrSeller: null, addrBuyerItems: null, addrBuyerCursor: null, addrSellerCursor: null, addrTab: 'seller', addrLoading: false, addrMore: false,
    copied: false };
  /* One config constant: swap to custom domains later in one place. */
  API_BASES = {
    'stellar:testnet': 'https://explorer-explorer.up.railway.app',
    'stellar:pubnet': 'https://explorer-mainnet-explorer.up.railway.app'
  };
  get API() { return this.API_BASES[this.state.network] || this.API_BASES['stellar:pubnet']; }
  expNet() { return (this.state.network || '').indexOf('pubnet') >= 0 ? 'public' : 'testnet'; }
  /* Network lives in the URL, like a normal explorer: mainnet is bare (/tx/..), testnet is
     prefixed (/testnet/tx/..). One place builds a path for a network; nav()/setNetwork() use it. */
  _href(net, p) {
    const prefix = net === 'stellar:testnet' ? '/testnet' : '';
    p = String(p || '').replace(/^\/+/, '');
    return p ? prefix + '/' + p : (prefix || '/');
  }
  _stripNet(pathname) {
    let p = String(pathname || '').replace(/^\/+/, '');
    let net = 'stellar:pubnet';
    if (p === 'testnet' || p.indexOf('testnet/') === 0) { net = 'stellar:testnet'; p = p.slice(7).replace(/^\/+/, ''); }
    return { net, path: p };
  }
  _netStateReset() {
    return { stats: null, items: [], cursor: null, more: false, facs: null,
      sellersData: null, sellersTotal: 0, sellersOffset: 0, facData: null, addrSeller: null, addrBuyerItems: null,
      eco: null, ecoTs: null, ecoHealth: null, ecoAsset: null,
      sellersKpiTotal: null, sellersKpiBazaar: null, sellersKpi7d: null, ecoSellersW: null, assetsTs: null, assetPage: 0,
      assetsWin: 'all', assetsWinStats: null, assetD: null,
      assetIcons: { ...(this._iconSeed || {}) } };
  }
  facName(n) { return n ? String(n).replace(/openzeppelin/ig, 'OZ') : n; }
  _codeMap = {
    'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA': 'USDC',
    'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75': 'USDC',
    'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV': 'EURC',
    'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA': 'XLM'
  };
  learnAssets(st) { ((st && st.byAsset) || []).forEach(a => { if (a.asset) this._codeMap[a.assetContract] = a.asset === 'native' ? 'XLM' : a.asset.split(':')[0]; }); this.harvestIcons((st && st.byAsset) || []); }
  learnItems(items) { (items || []).forEach(p => { if (p.assetCode) this._codeMap[p.assetContract] = p.assetCode; }); this.harvestIcons(items); }
  codeFor(contract) { return this._codeMap[contract] || null; }
  iconFor(code, sep11) {
    if (code === 'USDC') return '/svg/color/usdc.svg';
    if (code === 'XLM' || sep11 === 'native') return '/svg/color/xlm.svg';
    if (sep11 && sep11.indexOf(':') > 0) return (this.state.assetIcons || {})[sep11] || '';
    return '';
  }
  harvestIcons(list) {
    const net = (this.state.network || '').indexOf('testnet') >= 0 ? 'testnet' : 'public';
    (list || []).forEach(p => {
      const sep11 = p.asset;
      if (!sep11 || sep11 === 'native' || sep11.indexOf(':') < 0) return;
      const code = sep11.split(':')[0];
      if (code === 'USDC' || code === 'XLM') return;
      const cache = this.state.assetIcons || {};
      if (cache[sep11] !== undefined) return;
      this.setState(s => ({ assetIcons: { ...(s.assetIcons || {}), [sep11]: '' } }));
      fetch('https://api.stellar.expert/explorer/' + net + '/asset/meta?asset=' + sep11.replace(':', '-'))
        .then(r => r.json())
        .then(j => {
          const rec = j && j._embedded && j._embedded.records && j._embedded.records[0];
          const img = rec && rec.toml_info && (rec.toml_info.image || rec.toml_info.orgLogo);
          if (img) this.setState(s => ({ assetIcons: { ...(s.assetIcons || {}), [sep11]: img } }));
        }).catch(() => {});
    });
  }
  PALETTE = ['#FF4D00', '#1F6FEB', '#2FA36B', '#B58A00', '#8A5CF6', '#D64570'];
  componentDidMount() {
    document.body.classList.remove('dark');
    /* Seed icon cache from the local top-20 StellarExpert asset map (assets-icons.json). */
    fetch('/assets-icons.json').then(r => r.json()).then(m => {
      const seed = {};
      Object.keys(m).forEach(k => { if (m[k].icon) seed[k] = m[k].icon; });
      this._iconSeed = seed;
      this.setState(s => ({ assetIcons: { ...seed, ...(s.assetIcons || {}) } }));
    }).catch(() => {});
    document.body.style.setProperty('--acc', this.props.accent ?? '#FF4D00');
    this._onHash = () => this.applyRoute();
    window.addEventListener('popstate', this._onHash);
    this.applyRoute();
    if (!this.state.stats) fetch(this.statsUrl()).then(r => r.json()).then(st => { this.learnAssets(st); this.setState({ stats: st }); }).catch(() => {});
    fetch(this.API + '/stats').then(r => r.json()).then(st => this.learnAssets(st)).catch(() => {});
    this.loadFacs();
    this._t = setInterval(() => {
      if (this.state.route.name === 'feed') this.refresh();
      if (this.state.route.name === 'eco') this.loadEco();
    }, (this.props.pollSeconds ?? 12) * 1000);
  }
  componentDidUpdate() { document.body.style.setProperty('--acc', this.props.accent ?? '#FF4D00'); }
  componentWillUnmount() { clearInterval(this._t); window.removeEventListener('popstate', this._onHash); }
  nav(path) { this.setState({ menuOpen: false }); history.pushState(null, '', this._href(this.state.network, path)); this.applyRoute(); }
  applyRoute() {
    const { net, path } = this._stripNet(location.pathname);
    if (net !== this.state.network) {
      this.setState({ network: net, ...this._netStateReset() }, () => { this._ecoAt = 0; this.ensureStats(); this._route(path); });
      return;
    }
    this._route(path);
  }
  _route(path) {
    const query = location.search.replace(/^\?/, '');
    const [name, ...rest] = path.split('/');
    const arg = rest.join('/') || null;
    if (name === 'tx' && arg) { this.setState({ route: { name: 'tx', arg } }); this.loadTx(arg); }
    else if (name === 'facilitator' && arg) { this.setState({ route: { name: 'fac', arg } }); this.loadFac(arg); }
    else if (name === 'facilitators') { this.setState({ route: { name: 'facs', arg: null } }); this.loadFacs(); }
    else if (name === 'address' && arg) { this.setState({ route: { name: 'addr', arg }, addrTab: 'seller' }); this.loadAddr(arg); }
    else if (name === 'sellers') {
      const params = new URLSearchParams(query || '');
      const winP = ['24h', '7d', '30d'].indexOf(params.get('window')) >= 0 ? params.get('window') : (this.state.sellersWin || 'all');
      const regP = params.get('registered') === 'true' ? 'bazaar' : params.get('registered') === 'false' ? 'onchain' : (this.state.sellersReg || 'all');
      const pageP = parseInt(params.get('page') || '0', 10);
      this.setState({ route: { name: 'sellers', arg: null }, sellersWin: winP, sellersReg: regP });
      this.loadSellers(pageP > 1 ? (pageP - 1) * 10 : (this.state.sellersOffset || 0));
    }
    else if (name === 'asset' && arg) { this.setState({ route: { name: 'asset', arg } }); this.loadAsset(arg); }
    else if (name === 'assets') {
      const params = new URLSearchParams(query || '');
      const pageP = parseInt(params.get('page') || '0', 10);
      const winP = ['24h', '7d', '30d'].indexOf(params.get('window')) >= 0 ? params.get('window') : (this.state.assetsWin || 'all');
      this.setState({ route: { name: 'assets', arg: null }, assetPage: pageP > 1 ? pageP - 1 : (this.state.assetPage || 0) });
      if (winP !== (this.state.assetsWin || 'all')) this.setAssetsWin(winP);
      else if (winP !== 'all' && !this.state.assetsWinStats) fetch(this.API + '/stats?window=' + winP).then(r => r.json()).then(d => this.setState({ assetsWinStats: { window: winP, data: d } })).catch(() => {});
      this.ensureStats();
      this.loadAssetsTs();
    }
    else if (name === 'ecosystem') {
      const params = new URLSearchParams(query || '');
      const assetP = params.get('asset');
      const rangeP = ['24h', '7d', '30d', '90d', 'all'].indexOf(params.get('range')) >= 0 ? params.get('range') : null;
      const seriesP = ['payments', 'buyers', 'volume'].indexOf(params.get('series')) >= 0 ? params.get('series') : null;
      this.setState({
        route: { name: 'eco', arg: null },
        ecoAsset: assetP || this.state.ecoAsset || null,
        ecoRange: rangeP || this.state.ecoRange || 'all',
        ecoSeries: seriesP || this.state.ecoSeries || 'payments'
      }, () => this.loadEco());
      return;
    }
    else {
      const params = new URLSearchParams(query || '');
      const facParam = params.get('facilitator');
      const tier = facParam ? 'fac:' + facParam : (['rail402', 'verified-facilitator', 'x402-shaped'].indexOf(params.get('confidence')) >= 0 ? params.get('confidence') : 'all');
      const scheme = ['exact', 'upto'].indexOf(params.get('scheme')) >= 0 ? params.get('scheme') : 'all';
      const buyer = params.get('buyer'), seller = params.get('seller');
      const addrFilter = buyer ? { role: 'buyer', addr: buyer } : (seller ? { role: 'seller', addr: seller } : null);
      const changed = tier !== this.state.tier || scheme !== this.state.scheme || JSON.stringify(addrFilter) !== JSON.stringify(this.state.addrFilter || null);
      this.setState({ route: { name: 'feed', arg: null }, tier, scheme, addrFilter }, () => {
        if (changed || !this.state.items.length) { this.setState({ items: [], cursor: null }, () => this.load()); }
      });
    }
  }
  syncFeedHash() {
    const p = [];
    if (this.state.tier.indexOf('fac:') === 0) p.push('facilitator=' + encodeURIComponent(this.state.tier.slice(4)));
    else if (this.state.tier !== 'all') p.push('confidence=' + this.state.tier);
    if (this.state.scheme !== 'all') p.push('scheme=' + this.state.scheme);
    if (this.state.addrFilter) p.push(this.state.addrFilter.role + '=' + encodeURIComponent(this.state.addrFilter.addr));
    history.replaceState(null, '', this._href(this.state.network, '') + (p.length ? '?' + p.join('&') : ''));
  }
  statsUrl() { return this.API + '/stats?network=' + encodeURIComponent(this.state.network); }
  ensureStats() { if (!this.state.stats) fetch(this.statsUrl()).then(r => r.json()).then(st => { this.learnAssets(st); this.setState({ stats: st }); }).catch(() => {}); }
  setNetwork(network) {
    if (network === this.state.network) { this.setState({ netMenuOpen: false }); return; }
    this.setState({ netMenuOpen: false });
    // Switching network re-navigates to the same route under the other network's URL prefix,
    // so the address bar always reflects the network and links stay shareable. applyRoute() then
    // reads the new network back off the URL and resets per-network state.
    const cur = this._stripNet(location.pathname).path;
    history.pushState(null, '', this._href(network, cur) + location.search);
    this.applyRoute();
  }
  setAddrFilter(role, addr) {
    this.setState({ addrFilter: { role, addr }, items: [], cursor: null, ddOpen: null }, () => { this.syncFeedHash(); this.load(); });
  }
  feedUrl(extra, cursor) {
    const p = ['limit=10', 'network=' + encodeURIComponent(this.state.network)];
    if (this.state.addrFilter) p.push(this.state.addrFilter.role + '=' + encodeURIComponent(this.state.addrFilter.addr));
    if (this.state.tier.indexOf('fac:') === 0) p.push('facilitator=' + encodeURIComponent(this.state.tier.slice(4)));
    else if (this.state.tier !== 'all') p.push('confidence=' + this.state.tier);
    if (this.state.scheme !== 'all') p.push('scheme=' + this.state.scheme);
    if (extra) p.push(extra);
    if (cursor) p.push('cursor=' + encodeURIComponent(cursor));
    return this.API + '/feed?' + p.join('&');
  }
  async load() {
    this.setState({ feedErr: false });
    this.setState({ loading: true });
    try {
      const f = await fetch(this.feedUrl()).then(r => r.json());
      this.learnItems(f.items);
      this.setState({ items: f.items || [], cursor: f.nextCursor || null, more: !!f.nextCursor, loading: false, pendingNew: [] });
    } catch (e) { this.setState({ loading: false, feedErr: true }); }
  }
  async refresh() {
    try {
      const f = await fetch(this.feedUrl()).then(r => r.json());
      const seen = new Set(this.state.items.map(p => p.txHash));
      const pendSeen = new Set((this.state.pendingNew || []).map(p => p.txHash));
      const fresh = (f.items || []).filter(p => !seen.has(p.txHash) && !pendSeen.has(p.txHash)).map(p => ({ ...p, _new: true }));
      if (fresh.length) this.setState(s => ({ pendingNew: [...fresh, ...(s.pendingNew || [])].slice(0, 50) }));
      fetch(this.statsUrl()).then(r => r.json()).then(st => { this.learnAssets(st); this.setState({ stats: st }); }).catch(() => {});
    } catch (e) {}
  }
  async loadMore() {
    const cur = this.state.cursor; if (!cur) return;
    this.setState({ more: false });
    try {
      const f = await fetch(this.feedUrl(null, cur)).then(r => r.json());
      this.setState(s => ({ items: [...s.items, ...(f.items || [])], cursor: f.nextCursor || null, more: !!f.nextCursor }));
    } catch (e) { this.setState({ more: true }); }
  }
  setTier(t) { if (t === this.state.tier) return; this.setState({ tier: t, items: [], cursor: null }, () => { this.syncFeedHash(); this.load(); }); }
  setScheme(sc) { if (sc === this.state.scheme) return; this.setState({ scheme: sc, items: [], cursor: null }, () => { this.syncFeedHash(); this.load(); }); }
  loadFacs() {
    this.ensureStats();
    if (this.state.facs) return;
    this.setState({ facsLoading: true, facsErr: false });
    fetch(this.API + '/facilitators').then(r => r.json())
      .then(d => this.setState({ facs: (d.facilitators || []).sort((a, b) => (b.stats?.totalPayments || 0) - (a.stats?.totalPayments || 0)), facsLoading: false }))
      .catch(() => this.setState({ facsLoading: false, facsErr: true }));
    /* windows for the 30D column come from the cached /ecosystem call */
    if (!this.state.eco) fetch(this.API + '/ecosystem').then(r => r.json()).then(d => this.setState({ eco: d })).catch(() => {});
  }
  /* Ecosystem analytics: /ecosystem every >=30s, timeseries per range, /health freshness. */
  loadEco() {
    const now = Date.now();
    if (this.state.eco && now - (this._ecoAt || 0) < 30000) return;
    this._ecoAt = now;
    if (!this.state.eco) this.setState({ ecoLoading: true, ecoErr: false });
    fetch(this.API + '/ecosystem').then(r => r.json())
      .then(d => this.setState({ eco: d, ecoLoading: false }))
      .catch(() => this.setState({ ecoLoading: false, ecoErr: true }));
    this.loadEcoTs();
    this.loadEcoSellers();
    fetch(this.API + '/health').then(r => r.json()).then(h => this.setState({ ecoHealth: h })).catch(() => {});
  }
  loadEcoSellers() {
    /* Top sellers follow the range picker via GET /sellers?window= (omit = all-time). */
    const r = this.state.ecoRange || 'all';
    const win = r === '24h' || r === '7d' || r === '30d' ? r : null;
    fetch(this.API + '/sellers?limit=10&offset=0' + (win ? '&window=' + win : ''))
      .then(x => x.json())
      .then(d => this.setState({ ecoSellersW: d.items || [], ecoSellersWin: win || 'all' }))
      .catch(() => {});
  }
  loadEcoTs() {
    const r = this.state.ecoRange || 'all';
    const q = r === '24h' ? 'bucket=hour&hours=24' : 'bucket=day&days=' + (r === '7d' ? 7 : (r === '90d' || r === 'all') ? 90 : 30);
    fetch(this.API + '/ecosystem/timeseries?' + q).then(x => x.json()).then(d => this.setState({ ecoTs: d })).catch(() => {});
  }
  setEcoRange(r) { if (r === this.state.ecoRange) return; this.setState({ ecoRange: r, ecoTs: null, ecoSellersW: null }, () => { this.loadEcoTs(); this.loadEcoSellers(); this.syncEcoHash(); }); }
  syncEcoHash() {
    const eco = this.state.eco, first = eco && eco.totals && eco.totals.byAsset && eco.totals.byAsset[0];
    const isDefault = !this.state.ecoAsset || (first && this.state.ecoAsset === first.assetContract);
    const p = [];
    if (!isDefault) p.push('asset=' + encodeURIComponent(this.state.ecoAsset));
    if ((this.state.ecoRange || 'all') !== 'all') p.push('range=' + this.state.ecoRange);
    if ((this.state.ecoSeries || 'payments') !== 'payments') p.push('series=' + this.state.ecoSeries);
    history.replaceState(null, '', this._href(this.state.network, 'ecosystem') + (p.length ? '?' + p.join('&') : ''));
  }
  pickEcoAsset(contract) { this.setState({ ecoAsset: contract, ecoAssetMenu: false, ecoAssetQ: '' }, () => this.syncEcoHash()); }
  sellersQuery() {
    const w = this.state.sellersWin || 'all';
    const reg = this.state.sellersReg || 'all';
    let q = 'limit=10&offset=' + (this.state.sellersOffset || 0);
    if (w !== 'all') q += '&window=' + w;
    if (reg !== 'all') q += '&registered=' + (reg === 'bazaar' ? 'true' : 'false');
    return q;
  }
  loadSellers(offset) {
    this.setState({ sellersLoading: true, sellersErr: false, sellersOffset: offset }, () => {
      fetch(this.API + '/sellers?' + this.sellersQuery()).then(r => r.json())
        .then(d => this.setState({ sellersData: d.sellers || d.items || [], sellersTotal: (d.pagination && d.pagination.total) || 0, sellersLoading: false }))
        .catch(() => this.setState({ sellersLoading: false, sellersErr: true }));
      this.syncSellersHash();
    });
    /* KPI strip: cached one-off counts */
    if (this.state.sellersKpiTotal == null) fetch(this.API + '/sellers?limit=1&offset=0').then(r => r.json()).then(d => this.setState({ sellersKpiTotal: (d.pagination && d.pagination.total) || 0 })).catch(() => {});
    if (this.state.sellersKpiBazaar == null) fetch(this.API + '/sellers?limit=1&offset=0&registered=true').then(r => r.json()).then(d => this.setState({ sellersKpiBazaar: (d.pagination && d.pagination.total) || 0 })).catch(() => {});
    if (this.state.sellersKpi7d == null) fetch(this.API + '/sellers?limit=1&offset=0&window=7d').then(r => r.json()).then(d => this.setState({ sellersKpi7d: (d.pagination && d.pagination.total) || 0 })).catch(() => {});
  }
  setAssetsWin(w) {
    if (w === (this.state.assetsWin || 'all')) return;
    this.setState({ assetsWin: w, assetPage: 0, assetsWinStats: null }, () => {
      this.syncAssetsHash();
      if (w !== 'all') fetch(this.API + '/stats?window=' + w).then(r => r.json()).then(d => this.setState({ assetsWinStats: { window: w, data: d } })).catch(() => {});
    });
  }
  loadAsset(c) {
    this.setState({ assetD: null, assetDLoading: true, assetDErr: false, assetDCursor: null, assetDMore: false });
    fetch(this.API + '/asset/' + c).then(async r => {
      const d = await r.json();
      if (!r.ok) { this.setState({ assetDErr: d, assetDLoading: false }); return; }
      this.learnItems(d.payments);
      this.setState({ assetD: d, assetDLoading: false, assetDCursor: d.nextCursor || null, assetDMore: !!d.nextCursor });
    }).catch(() => this.setState({ assetDErr: { code: 'network_error', reason: 'Could not reach the explorer API.' }, assetDLoading: false }));
  }
  async loadMoreAsset() {
    const { route, assetDCursor } = this.state; if (!assetDCursor) return;
    this.setState({ assetDMore: false });
    try {
      const f = await fetch(this.API + '/feed?limit=20&asset=' + encodeURIComponent(route.arg) + '&cursor=' + encodeURIComponent(assetDCursor)).then(r => r.json());
      this.learnItems(f.items);
      this.setState(s => ({ assetD: { ...s.assetD, payments: [...(s.assetD.payments || []), ...(f.items || [])] }, assetDCursor: f.nextCursor || null, assetDMore: !!f.nextCursor }));
    } catch (e) { this.setState({ assetDMore: true }); }
  }
  loadAssetsTs() {
    if (this.state.assetsTs) return;
    fetch(this.API + '/ecosystem/timeseries?bucket=day&days=30').then(r => r.json()).then(d => this.setState({ assetsTs: d })).catch(() => {});
  }
  syncAssetsHash() {
    const p = [];
    if ((this.state.assetsWin || 'all') !== 'all') p.push('window=' + this.state.assetsWin);
    if ((this.state.assetPage || 0) > 0) p.push('page=' + ((this.state.assetPage || 0) + 1));
    history.replaceState(null, '', this._href(this.state.network, 'assets') + (p.length ? '?' + p.join('&') : ''));
  }
  setSellersWin(w) { if (w === (this.state.sellersWin || 'all')) return; this.setState({ sellersWin: w }, () => this.loadSellers(0)); }
  setSellersReg(r) { if (r === (this.state.sellersReg || 'all')) return; this.setState({ sellersReg: r }, () => this.loadSellers(0)); }
  syncSellersHash() {
    const p = [];
    if ((this.state.sellersWin || 'all') !== 'all') p.push('window=' + this.state.sellersWin);
    if ((this.state.sellersReg || 'all') !== 'all') p.push('registered=' + (this.state.sellersReg === 'bazaar' ? 'true' : 'false'));
    if ((this.state.sellersOffset || 0) > 0) p.push('page=' + (Math.floor(this.state.sellersOffset / 10) + 1));
    history.replaceState(null, '', this._href(this.state.network, 'sellers') + (p.length ? '?' + p.join('&') : ''));
  }
  loadFac(id) {
    this.setState({ facData: null, facLoading: true, facCursor: null, facMore: false });
    fetch(this.API + '/facilitator/' + id).then(r => r.json())
      .then(d => { this.learnItems(d.payments); this.setState({ facData: d, facLoading: false, facCursor: d.nextCursor || null, facMore: !!d.nextCursor }); })
      .catch(() => this.setState({ facLoading: false }));
  }
  async loadMoreFac() {
    const { route, facCursor } = this.state; if (!facCursor) return;
    this.setState({ facMore: false });
    try {
      const f = await fetch(this.API + '/feed?limit=20&facilitator=' + encodeURIComponent(route.arg) + '&cursor=' + encodeURIComponent(facCursor)).then(r => r.json());
      this.setState(s => ({ facData: { ...s.facData, payments: [...(s.facData.payments || []), ...(f.items || [])] }, facCursor: f.nextCursor || null, facMore: !!f.nextCursor }));
    } catch (e) { this.setState({ facMore: true }); }
  }
  loadTx(hash) {
    this.setState({ txData: null, txErr: null, txLoading: true, raw: null, rawOpen: false, copied: false });
    fetch(this.API + '/tx/' + hash).then(async r => {
      const d = await r.json();
      if (!r.ok) { this.setState({ txErr: d, txLoading: false }); return; }
      this.learnItems([d]);
      this.setState({ txData: d, raw: d.raw || null, txLoading: false });
    }).catch(() => this.setState({ txErr: { code: 'network_error', reason: 'Could not reach the explorer API.' }, txLoading: false }));
  }
  loadAddr(addr) {
    this.setState({ addrSeller: null, addrBuyerItems: null, addrLoading: true, addrMore: false, addrSellerCursor: null, addrBuyerCursor: null, copied: false });
    Promise.all([
      fetch(this.API + '/seller/' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(this.API + '/feed?limit=20&buyer=' + encodeURIComponent(addr)).then(r => r.json()).catch(() => ({ items: [] }))
    ]).then(([sell, buy]) => {
      const sellerHas = sell && sell.payments && sell.payments.length;
      const buyerHas = buy.items && buy.items.length;
      this.learnItems([...(sell && sell.payments || []), ...(buy.items || [])]);
      this.setState({
        addrSeller: sell, addrBuyerItems: buy.items || [],
        addrSellerCursor: sell && sell.nextCursor ? sell.nextCursor : null,
        addrBuyerCursor: buy.nextCursor || null,
        addrTab: sellerHas || !buyerHas ? 'seller' : 'buyer',
        addrLoading: false
      }, () => this.syncAddrMore());
    });
  }
  syncAddrMore() {
    const { addrTab, addrSellerCursor, addrBuyerCursor } = this.state;
    this.setState({ addrMore: addrTab === 'seller' ? !!addrSellerCursor : !!addrBuyerCursor });
  }
  async loadMoreAddr() {
    const { route, addrTab, addrSellerCursor, addrBuyerCursor } = this.state;
    const cur = addrTab === 'seller' ? addrSellerCursor : addrBuyerCursor;
    if (!cur) return;
    this.setState({ addrMore: false });
    try {
      const param = addrTab === 'seller' ? 'seller' : 'buyer';
      const f = await fetch(this.API + '/feed?limit=20&' + param + '=' + encodeURIComponent(route.arg) + '&cursor=' + encodeURIComponent(cur)).then(r => r.json());
      if (addrTab === 'seller') this.setState(s => ({ addrSeller: { ...s.addrSeller, payments: [...(s.addrSeller.payments || []), ...(f.items || [])] }, addrSellerCursor: f.nextCursor || null }), () => this.syncAddrMore());
      else this.setState(s => ({ addrBuyerItems: [...(s.addrBuyerItems || []), ...(f.items || [])], addrBuyerCursor: f.nextCursor || null }), () => this.syncAddrMore());
    } catch (e) { this.setState({ addrMore: true }); }
  }
  toggleRaw() { this.setState(s => ({ rawOpen: !s.rawOpen })); }
  copy(v) { try { navigator.clipboard.writeText(v); this.setState({ copied: true }); setTimeout(() => this.setState({ copied: false }), 1200); } catch (e) {} }
  doSearch() {
    const q = this.state.q.trim();
    if (/^[0-9a-fA-F]{64}$/.test(q)) { this.setState({ q: '', searchErr: false }); this.nav('tx/' + q.toLowerCase()); }
    else if (/^[GC][A-Z2-7]{55}$/.test(q)) { this.setState({ q: '', searchErr: false }); this.nav('address/' + q); }
    else this.setState({ searchErr: true });
  }
  ago(iso) { if (!iso) return '—'; const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return Math.max(1, Math.floor(d)) + 's'; if (d < 3600) return Math.floor(d / 60) + 'm'; if (d < 86400) return Math.floor(d / 3600) + 'h'; return Math.floor(d / 86400) + 'd'; }
  short(a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : ''; }
  n(x) { return x != null ? Number(x).toLocaleString('en-US') : '—'; }
  vol(total) { const v = Number(total) / 1e7; return v >= 1000 ? this.n(Math.round(v)) : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  confMap() {
    return {
      'rail402': { label: 'RAIL402', fg: 'var(--onacc)', bg: 'var(--acc)', bd: 'var(--acc)' },
      'verified-facilitator': { label: 'VERIFIED', fg: 'var(--panel)', bg: 'var(--ink)', bd: 'var(--ink)' },
      'x402-shaped': { label: 'UNKNOWN', fg: 'var(--mut)', bg: 'transparent', bd: 'transparent' }
    };
  }
  mapRow(p) {
    const c = this.confMap()[p.confidence] || this.confMap()['x402-shaped'];
    const inFeed = () => this.state.route.name === 'feed';
    return {
      time: this.ago(p.closedAt),
      timeTitle: p.closedAt ? new Date(p.closedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '',
      hashShort: p.txHash.slice(0, 6) + '…' + p.txHash.slice(-4),
      buyerShort: this.short(p.buyer), sellerShort: this.short(p.seller),
      isContract: p.buyer && p.buyer[0] === 'C',
      fac: p.facilitator ? this.facName(p.facilitator.displayName) : '—',
      facFg: p.facilitator ? 'var(--ink)' : 'var(--line)',
      facCursor: p.facilitator ? 'pointer' : 'default',
      settledTxt: p.facilitator ? this.facName(p.facilitator.displayName).toUpperCase() : 'UNKNOWN',
      schemeTxt: (p.scheme || '').toUpperCase(),
      confLabel: c.label, confFg: c.fg, confBg: c.bg, confBd: c.bd,
      amtTxt: p.scheme === 'upto' && p.ceilingDecimal ? p.amountDecimal + ' of ' + p.ceilingDecimal : p.amountDecimal,
      isUpto: p.scheme === 'upto' && !!p.ceilingDecimal,
      uptoPct: p.scheme === 'upto' && p.ceiling && Number(p.ceiling) > 0 ? Math.min(100, Number(p.amount) / Number(p.ceiling) * 100).toFixed(0) + '%' : '0%',
      asset: p.assetCode || this.codeFor(p.assetContract) || (p.assetContract ? p.assetContract.slice(0, 4) + '…' : ''),
      iconUrl: this.iconFor(p.assetCode || this.codeFor(p.assetContract), p.asset),
      hasIcon: !!this.iconFor(p.assetCode || this.codeFor(p.assetContract), p.asset),
      anim: p._new ? 'rowin 1.4s ease-out' : 'none',
      openTx: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.nav('tx/' + p.txHash); },
      openBuyer: (e) => { if (e && e.stopPropagation) e.stopPropagation(); inFeed() ? this.setAddrFilter('buyer', p.buyer) : this.nav('address/' + p.buyer); },
      openSeller: (e) => { if (e && e.stopPropagation) e.stopPropagation(); inFeed() ? this.setAddrFilter('seller', p.seller) : this.nav('address/' + p.seller); },
      openFac: (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (p.facilitator) this.nav('facilitator/' + p.facilitator.id); },
      copyHash: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.copy(p.txHash); },
      sellerLabel: p.serviceName || this.short(p.seller),
      sellerTitle: p.serviceName ? p.seller : ''
    };
  }
  txSections(t) {
    const EX = 'https://stellar.expert/explorer/' + this.expNet();
    const acct = a => a ? EX + (a[0] === 'C' ? '/contract/' : '/account/') + a : null;
    const row = (k, v, o) => v == null ? null : Object.assign({ k, v: String(v), full: '', expert: null, go: null }, o || {});
    const feeXlm = t.feeChargedStroops ? (Number(t.feeChargedStroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, '') + ' XLM' : null;
    const closed = t.closedAt ? this.ago(t.closedAt) + ' AGO · ' + new Date(t.closedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
    const addr = (k, a, extra) => a == null ? null : row(k, this.short(a), Object.assign({ full: a, expert: acct(a) }, extra || {}));
    const sections = [
      t.serviceName || t.resource ? { t: 'WHAT WAS BOUGHT', rows: [
        row('SERVICE', t.serviceName),
        t.resource ? row('RESOURCE', t.resource, { full: t.resource }) : null
      ] } : null,
      { t: 'SETTLEMENT', rows: [
        row('CLOSED AT', closed),
        row('LEDGER', t.ledger, { expert: t.ledger != null ? EX + '/ledger/' + t.ledger : null }),
        row('NETWORK', t.network)
      ] },
      { t: 'ATTRIBUTION', rows: [
        t.facilitator
          ? row('SETTLED BY', this.facName(t.facilitator.displayName), { go: () => this.nav('facilitator/' + t.facilitator.id) })
          : row('SETTLED BY', 'UNKNOWN FACILITATOR'),
        row('CONFIDENCE', (t.confidence || '').toUpperCase()),
        row('SCHEME', (t.scheme || '').toUpperCase() + (t.scheme === 'upto' && t.ceilingDecimal ? ' · ' + t.amountDecimal + ' OF ' + t.ceilingDecimal + ' AUTHORIZED' : ''))
      ] }
    ].filter(Boolean);
    this._techRows = [
      addr('TX SOURCE', t.txSource),
      addr('FEE SOURCE', t.feeSource),
      row('ASSET', t.asset || this.codeFor(t.assetContract) || '—', (t.asset || this.codeFor(t.assetContract)) ? { full: t.asset || this.codeFor(t.assetContract) } : {}),
      row('ASSET CONTRACT', this.short(t.assetContract), t.assetContract ? { full: t.assetContract, expert: EX + '/contract/' + t.assetContract } : {}),
      row('NETWORK FEE', feeXlm, t.feeChargedStroops ? { full: t.feeChargedStroops + ' stroops' } : {}),
      row('SIG EXP LEDGER', t.sigExpirationLedger),
      row('MEMO', t.memo), row('MUXED ID', t.muxedId)
    ].filter(Boolean).map(f => ({ ...f, hasCopy: !!f.full, copy: () => this.copy(f.full), hasExpert: !!f.expert }));
    return sections.map(s => ({
      t: s.t,
      rows: s.rows.filter(Boolean).map(f => ({
        ...f,
        hasCopy: !!f.full, copy: () => this.copy(f.full),
        hasExpert: !!f.expert,
        cur: f.go ? 'pointer' : 'default',
        deco: f.go ? 'underline' : 'none',
        hoverFg: f.go ? 'var(--acc)' : 'var(--ink)'
      }))
    })).filter(s => s.rows.length);
  }
  fmtCompact(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  ecoVals() {
    const eco = this.state.eco, ts = this.state.ecoTs, h = this.state.ecoHealth;
    const range = this.state.ecoRange || 'all', series = this.state.ecoSeries || 'payments';
    const tot = eco ? eco.totals : null;
    const codeOf = a => a.assetCode || this.codeFor(a.assetContract) || (a.assetContract ? a.assetContract.slice(0, 5) + '…' + a.assetContract.slice(-4) : '?');
    /* Assets are count-ranked by the API; byAsset[0] IS the top asset. Never compare volumes across assets. */
    const byAsset = tot && tot.byAsset ? tot.byAsset : [];
    const sel = byAsset.find(a => a.assetContract === this.state.ecoAsset) || byAsset[0] || null;
    const selCode = sel ? codeOf(sel) : '';
    const inSel = arr => {
      const v = (arr || []).find(x => x.assetContract === (sel && sel.assetContract));
      return v ? this.fmtCompact(Number(v.totalDecimal)) + ' ' + selCode : '0 ' + selCode;
    };
    const volTxt = arr => {
      const v = (arr || [])[0];
      return v ? this.fmtCompact(Number(v.totalDecimal)) + ' ' + codeOf(v) : '—';
    };
    const pts = ts ? (ts.points || []) : [];
    const selBucket = p => (p.volume || []).find(x => x.assetContract === (sel && sel.assetContract));
    const val = p => {
      if (series === 'buyers') return p.uniqueBuyers;
      const v = selBucket(p);
      return series === 'volume' ? (v ? Number(v.totalDecimal || 0) : 0) : (v ? v.count : 0);
    };
    const maxV = Math.max(1, ...pts.map(val));
    const fmtDay = iso => { const d = new Date(iso); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
    const fmtHour = iso => { const d = new Date(iso); return String(d.getUTCHours()).padStart(2, '0') + ':00'; };
    const isHour = ts && ts.bucket === 'hour';
    const hi = this.state.ecoHover;
    const bars = pts.map((p, i) => {
      const v = val(p), partial = i === pts.length - 1, hov = hi === i;
      return {
        h: Math.max(v > 0 ? 3 : 1, Math.round(v / maxV * 100)) + '%',
        bg: hov ? 'var(--ink)' : partial ? 'var(--stripe)' : v > 0 ? 'var(--acc)' : 'var(--line)',
        bd: partial && !hov ? '1px solid var(--mut)' : 'none',
        enter: () => this.setState({ ecoHover: i }),
        leave: () => this.setState({ ecoHover: null })
      };
    });
    const hp = hi != null && pts[hi] ? pts[hi] : null;
    const hv = hp ? selBucket(hp) : null;
    const tipLeft = hp ? Math.min(90, Math.max(10, (hi + 0.5) / Math.max(1, pts.length) * 100)).toFixed(1) + '%' : '50%';
    const allZero = pts.length > 0 && pts.every(p => p.payments === 0);
    /* Sections below the chart follow the global range picker. 90d/all fall back to all-time (facilitator windows only carry 24h/7d/30d). */
    const shareWin = range === '24h' || range === '7d' || range === '30d' ? range : 'all';
    const wRows = eco ? ['24h', '7d', '30d'].map(k => {
      const w = eco.windows && eco.windows[k] ? eco.windows[k] : {};
      const wv = (w.volume || []).find(x => x.assetContract === (sel && sel.assetContract));
      /* Pace trend: this window's daily rate vs the next-larger window's daily rate. */
      const W = eco.windows || {};
      const allDays = tot && tot.firstPaymentAt ? Math.max(1, (Date.now() - new Date(tot.firstPaymentAt).getTime()) / 86400000) : 0;
      const cmp = k === '24h' ? '7D' : k === '7d' ? '30D' : 'ALL TIME';
      const trend = (field) => {
        const cur = w[field] || 0;
        const rate = k === '24h' ? cur : k === '7d' ? cur / 7 : cur / 30;
        const baseCnt = k === '24h' ? ((W['7d'] && W['7d'][field]) || 0) / 7
          : k === '7d' ? ((W['30d'] && W['30d'][field]) || 0) / 30
          : (field === 'payments' && allDays ? (tot.totalPayments || 0) / allDays : 0);
        const dlt = baseCnt > 0 ? (rate - baseCnt) / baseCnt * 100 : null;
        return {
          show: dlt != null && Math.abs(dlt) >= 1,
          txt: dlt != null ? (dlt >= 0 ? '▲ +' : '▼ ') + Math.abs(dlt).toFixed(0) + '%' : '',
          bg: dlt != null && dlt >= 0 ? '#2FA36B' : '#D64570',
          title: 'daily pace vs the ' + cmp + ' average'
        };
      };
      /* Buyers/sellers badges show the raw NEW count, not a pace percentage. */
      const cntBadge = (n) => ({ show: n > 0, txt: '▲ +' + this.n(n) + ' NEW', bg: '#2FA36B', title: 'first-time addresses in this window' });
      const tPay = trend('payments'), tBuy = cntBadge(w.newBuyers || 0), tSell = cntBadge(w.newSellers || 0);
      return { k: k.toUpperCase(), bg: k === shareWin ? 'var(--head)' : 'transparent',
        trendShow: tPay.show, trendTxt: tPay.txt, trendBg: tPay.bg, trendTitle: tPay.title,
        buyTrendShow: tBuy.show, buyTrendTxt: tBuy.txt, buyTrendBg: tBuy.bg, buyTrendTitle: tBuy.title,
        sellTrendShow: tSell.show, sellTrendTxt: tSell.txt, sellTrendBg: tSell.bg, sellTrendTitle: tSell.title,
        pay: this.n(w.payments || 0),
        vol: wv ? this.fmtCompact(Number(wv.totalDecimal)) : '0', volCode: selCode,
        buyers: this.n(w.uniqueBuyers || 0),
        sellers: this.n(w.uniqueSellers || 0) };
    }) : [];
    const facArr = eco ? (eco.facilitators || []) : [];
    const facCnt = f => shareWin === 'all' ? (f.payments || 0) : ((f.windows && f.windows[shareWin]) || 0);
    const shareSum = facArr.reduce((a, f) => a + facCnt(f), 0) || 1;
    const facSorted = facArr.slice().sort((a, b) => facCnt(b) - facCnt(a));
    const ecoFacs = facSorted.map((f, i) => ({
      name: f.facilitatorId ? this.facName(f.displayName || f.facilitatorId).toUpperCase() : 'UNATTRIBUTED',
      known: !!f.facilitatorId,
      color: f.facilitatorId ? this.PALETTE[i % this.PALETTE.length] : 'var(--cat-unknown, #9A9A90)',
      isStripe: !f.facilitatorId,
      vTxt: f.facilitatorId ? (f.verified ? 'VERIFIED' : 'UNVERIFIED') : '▨ UNKNOWN OPERATOR',
      sharePct: (facCnt(f) / shareSum * 100).toFixed(2) + '%',
      shareW: Math.max(0.5, facCnt(f) / shareSum * 100) + '%',
      payTxt: this.n(facCnt(f)),
      w30Txt: shareWin === 'all' ? '30D ' + this.n((f.windows && f.windows['30d']) || 0) : 'ALL ' + this.n(f.payments),
      lastTxt: f.lastPaymentAt ? this.ago(f.lastPaymentAt) + ' ago' : '—',
      open: () => { if (f.facilitatorId) this.nav('facilitator/' + f.facilitatorId); },
      cursor: f.facilitatorId ? 'pointer' : 'default'
    }));
    const sellersSrc = this.state.ecoSellersW != null ? this.state.ecoSellersW : (eco ? (eco.topSellers || []) : []);
    const sellWin = this.state.ecoSellersW != null ? (this.state.ecoSellersWin || 'all') : '30d';
    const sellBase = sellWin === 'all' ? (tot ? tot.totalPayments || 0 : 0)
      : (eco && eco.windows && eco.windows[sellWin] ? eco.windows[sellWin].payments || 0 : 0);
    const topSellers = sellersSrc.map((s, i) => ({
      rank: String(i + 1).padStart(2, '0'),
      sharePct: sellBase ? Math.max(0.5, Math.min(100, (s.payments || 0) / sellBase * 100)).toFixed(1) + '%' : '0%',
      name: s.serviceName || this.short(s.payTo),
      named: !!s.serviceName,
      addr: this.short(s.payTo),
      payTxt: this.n(s.payments), buyTxt: this.n(s.uniqueBuyers), volTxt: inSel(s.volume),
      lastTxt: (s.lastSeenAt || s.lastPaymentAt) ? this.ago(s.lastSeenAt || s.lastPaymentAt) + ' ago' : '—',
      copy: () => this.copy(s.payTo),
      open: () => this.nav('address/' + s.payTo)
    }));
    const cov = eco && eco.coverage && eco.coverage[0] ? eco.coverage[0].watchedSacs : null;
    const covTxt = cov === 'all' || !cov ? 'All assets on this network are watched.'
      : 'Coverage: ' + cov.map(c => this.codeFor(c) || c.slice(0, 5) + '…').join(', ') + ' (plus full history of known facilitators in any asset).';
    const ingest = h && h.ingest && h.ingest[0] ? h.ingest[0] : null;
    const tab = (on) => ({ bg: on ? 'var(--ink)' : 'var(--panel)', fg: on ? 'var(--panel)' : 'var(--ink)' });
    return {
      ecoLoading: !!this.state.ecoLoading && !eco,
      ecoReady: !!eco,
      ecoPayTxt: tot ? this.n(tot.totalPayments) : '…',
      ecoVolTxt: sel ? this.fmtCompact(Number(sel.totalDecimal)) : '…',
      ecoVolCode: sel ? selCode + ' SETTLED' : '',
      ecoTopAssetLabel: sel ? ((byAsset[0] && sel.assetContract === byAsset[0].assetContract ? 'TOP ASSET · ' : 'ASSET · ') + selCode) : 'TOP ASSET',
      ecoAssetShareTxt: sel && tot && tot.totalPayments ? this.n(sel.count) + ' payments (' + Math.round(sel.count / tot.totalPayments * 100) + '%)' : '',
      ecoSelCode: selCode || '…',
      ecoSelIcon: sel ? this.iconFor(selCode, sel.asset) : '',
      ecoSelHasIcon: !!(sel && this.iconFor(selCode, sel.asset)),
      ecoAssetMenuOpen: !!this.state.ecoAssetMenu,
      toggleEcoAssetMenu: () => this.setState(s => ({ ecoAssetMenu: !s.ecoAssetMenu, ecoAssetQ: '' })),
      ecoAssetQ: this.state.ecoAssetQ || '',
      setEcoAssetQ: (e) => this.setState({ ecoAssetQ: e.target.value }),
      ecoAssetOpts: byAsset
        .filter(a => {
          const q = (this.state.ecoAssetQ || '').trim().toLowerCase();
          if (!q) return true;
          return codeOf(a).toLowerCase().indexOf(q) >= 0 || (a.assetContract || '').toLowerCase().indexOf(q) >= 0;
        })
        .slice(0, 40)
        .map(a => {
          const on = sel && a.assetContract === sel.assetContract;
          const icon = this.iconFor(codeOf(a), a.asset);
          return {
            code: codeOf(a), sub: this.n(a.count) + ' PAYMENTS · ' + this.fmtCompact(Number(a.totalDecimal)) + ' SETTLED',
            icon, hasIcon: !!icon, noIcon: !icon,
            pick: () => this.pickEcoAsset(a.assetContract),
            bg: on ? 'var(--ink)' : 'var(--panel)', fg: on ? 'var(--panel)' : 'var(--ink)',
            hoverBg: on ? 'var(--ink)' : 'var(--head)', hoverFg: on ? 'var(--panel)' : 'var(--ink)',
            mutFg: on ? 'var(--line)' : 'var(--mut)'
          };
        }),
      ecoSinceTxt: tot && tot.firstPaymentAt
        ? 'First data from ' + new Date(tot.firstPaymentAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
        : '',
      ecoSinceHint: this.state.network === 'stellar:pubnet' ? 'first known settlement' : 'current testnet epoch',
      ecoHasSince: !!(tot && tot.firstPaymentAt),
      ecoBuyTxt: tot ? this.n(tot.uniqueBuyers) : '…',
      ecoSellTxt: tot ? this.n(tot.uniqueSellers) : '…',
      ecoFacCntTxt: eco ? this.n(facArr.filter(f => f.facilitatorId).length) : '…',
      ecoLastTxt: tot && tot.lastPaymentAt ? this.ago(tot.lastPaymentAt).toUpperCase() + ' AGO' : '—',
      ecoBars: bars, ecoHasTs: pts.length > 0, ecoTsLoading: !ts,
      ecoMaxTxt: (series === 'volume' ? this.fmtCompact(Math.max(0, ...pts.map(val))) + ' ' + selCode : this.n(Math.max(0, ...pts.map(val)))) + ' MAX',
      ...(() => {
        /* Range-scoped scheme split summed from the timeseries buckets (all assets; API has no per-asset scheme). */
        let e = 0, u = 0;
        if (range === 'all' || !pts.length) { e = (tot && tot.byScheme && tot.byScheme.exact) || 0; u = (tot && tot.byScheme && tot.byScheme.upto) || 0; }
        else pts.forEach(p => { e += (p.byScheme && p.byScheme.exact) || 0; u += (p.byScheme && p.byScheme.upto) || 0; });
        return {
          ecoSchemeExactTxt: this.n(e), ecoSchemeUptoTxt: this.n(u),
          ecoUptoW: e + u ? Math.max(u / (e + u) * 100, u > 0 ? 1 : 0) + '%' : '0%'
        };
      })(),
      ecoShareTitle: (shareWin === 'all' ? 'MARKET SHARE · ALL TIME' : 'MARKET SHARE · TRAILING ' + shareWin.toUpperCase()) + ' · PAYMENT COUNTS, ALL ASSETS',
      ecoGrowthTitle: 'GROWTH · TRAILING WINDOWS · VOLUME IN ' + selCode,
      ecoSellersTitle: 'TOP SELLERS · ' + (sellWin === 'all' ? 'ALL TIME' : 'TRAILING ' + sellWin.toUpperCase()) + ' · VOLUME IN ' + selCode,
      ecoScopeTxt: 'CHART SCOPED TO ' + selCode + ' · HOVER THE BARS FOR PER-' + (isHour ? 'HOUR' : 'DAY') + ' DETAIL',
      tipShow: !!hp,
      tipLeft,
      tipTitle: hp ? ((isHour ? hp.start.slice(0, 13).replace('T', ' ') + ':00 UTC' : hp.bucket) + (hi === pts.length - 1 ? ' · IN PROGRESS' : '')) : '',
      tipRow1: hp ? this.n(hv ? hv.count : 0) + ' ' + selCode + ' PAYMENTS · ' + this.fmtCompact(hv ? Number(hv.totalDecimal || 0) : 0) + ' ' + selCode : '',
      tipRow2: hp ? 'BUYERS ' + this.n(hp.uniqueBuyers) + ' (ALL) · EXACT ' + this.n((hp.byScheme && hp.byScheme.exact) || 0) + ' / UPTO ' + this.n((hp.byScheme && hp.byScheme.upto) || 0) : '',
      ecoChartQuiet: allZero,
      ecoQuietTxt: 'No payments in this range. Last payment ' + (tot && tot.lastPaymentAt ? this.ago(tot.lastPaymentAt) + ' ago' : 'unknown') + '. Quiet windows are normal on an early network.',
      ecoFromTxt: pts.length ? (isHour ? fmtHour(pts[0].start) + ' UTC' : fmtDay(pts[0].start)) : '',
      ecoToTxt: pts.length ? (isHour ? 'NOW' : 'TODAY (IN PROGRESS)') : '',
      ecoRangeTabs: ['24h', '7d', '30d', '90d', 'all'].map(r => ({ label: r === 'all' ? 'ALL TIME' : r.toUpperCase(), pick: () => this.setEcoRange(r), ...tab(r === range) })),
      pickSeriesPay: () => this.setState({ ecoSeries: 'payments' }, () => this.syncEcoHash()),
      pickSeriesBuy: () => this.setState({ ecoSeries: 'buyers' }, () => this.syncEcoHash()),
      pickSeriesVol: () => this.setState({ ecoSeries: 'volume' }, () => this.syncEcoHash()),
      serPayBg: tab(series === 'payments').bg, serPayFg: tab(series === 'payments').fg,
      serBuyBg: tab(series === 'buyers').bg, serBuyFg: tab(series === 'buyers').fg,
      serVolBg: tab(series === 'volume').bg, serVolFg: tab(series === 'volume').fg,
      ecoWindows: wRows, ecoFacs, ecoTopSellers: topSellers,
      ecoHasSellers: topSellers.length > 0,
      ecoCovTxt: covTxt,
      ecoFreshTxt: ingest && ingest.lastPollAt ? 'Data freshness: last ledger poll ' + this.ago(ingest.lastPollAt) + ' ago.' : '',
      ecoFreshColor: h && h.status === 'degraded' ? '#B58A00' : '#2FA36B',
      ecoGenTxt: eco && eco.generatedAt ? 'Generated ' + this.ago(eco.generatedAt) + ' ago' : ''
    };
  }
  renderVals() {
    const { route, stats, items, loading, tier, scheme, more, q, searchErr,
      facs, facsLoading, facData, facLoading, facMore,
      txData, txLoading, txErr, raw, rawOpen,
      addrSeller, addrBuyerItems, addrTab, addrLoading, addrMore, copied } = this.state;
    const bc = stats ? stats.byConfidence : {};
    const total = stats ? stats.totalPayments : 0;
    const pct = k => total ? Math.max(0.5, (bc[k] || 0) / total * 100).toFixed(1) + '%' : '0%';
    /* Top asset = byAsset[0] (API list is count-sorted); volume shown in its own unit only. */
    const topA = stats && stats.byAsset && stats.byAsset.length ? stats.byAsset[0] : null;
    const topACode = topA ? (topA.asset === 'native' ? 'XLM' : (topA.asset ? topA.asset.split(':')[0] : (this.codeFor(topA.assetContract) || topA.assetContract.slice(0, 5) + '…'))) : '';
    const nb = (on) => on ? 'var(--ink)' : 'var(--panel)';
    const nf = (on) => on ? 'var(--panel)' : 'var(--ink)';
    const tabs = [
      { id: 'all', label: 'ALL', c: total }, { id: 'rail402', label: 'RAIL402', c: bc['rail402'] },
      { id: 'verified-facilitator', label: 'VERIFIED', c: bc['verified-facilitator'] }, { id: 'x402-shaped', label: 'UNKNOWN', c: bc['x402-shaped'] }
    ].map((t, i) => ({ label: t.label, countTxt: t.c != null ? this.n(t.c) : '', pick: () => this.setTier(t.id), bg: nb(t.id === tier), fg: nf(t.id === tier), bl: i === 0 ? 'none' : '1.5px solid var(--ink)' }));
    const bs = stats ? stats.byScheme : {};
    const schemeTabs = [
      { id: 'all', label: 'ALL', c: total }, { id: 'exact', label: 'EXACT', c: bs.exact }, { id: 'upto', label: 'UPTO', c: bs.upto }
    ].map((t, i) => ({ label: t.label, countTxt: t.c != null ? this.n(t.c) : '', pick: () => this.setScheme(t.id), bg: nb(t.id === scheme), fg: nf(t.id === scheme), bl: i === 0 ? 'none' : '1.5px solid var(--ink)' }));
    const af0 = this.state.addrFilter || null;
    const dd = this.state.ddOpen || null;
    const facBS = id => { const f = (facs || []).find(x => x.id === id); return (f && f.stats && f.stats.byScheme) || null; };
    const sumBS = filterFn => {
      let e = 0, u = 0, any = false;
      (facs || []).forEach(f => { if (filterFn(f) && f.stats && f.stats.byScheme) { e += f.stats.byScheme.exact || 0; u += f.stats.byScheme.upto || 0; any = true; } });
      return any ? { exact: e, upto: u } : null;
    };
    const attrBS = sumBS(() => true);
    const unknownBS = stats && attrBS ? { exact: Math.max(0, (bs.exact || 0) - attrBS.exact), upto: Math.max(0, (bs.upto || 0) - attrBS.upto) } : null;
    const tierBS = t => t === 'all' ? (stats ? bs : null)
      : t.indexOf('fac:') === 0 ? facBS(t.slice(4))
      : t === 'rail402' ? facBS('rail402')
      : t === 'verified-facilitator' ? sumBS(f => f.verified && f.id !== 'rail402')
      : unknownBS;
    const curBS = tierBS(tier);
    const confOpts = [
      { id: 'all', label: 'ALL', tot: total },
      ...(facs || []).map(f => ({ id: 'fac:' + f.id, label: this.facName(f.displayName || f.id).toUpperCase(), tot: f.stats ? f.stats.totalPayments : null })),
      { id: 'x402-shaped', label: 'UNKNOWN', tot: bc['x402-shaped'] }
    ].map(o => {
      const b = tierBS(o.id);
      const c = scheme === 'all' ? o.tot : (b ? b[scheme] : null);
      return { id: o.id, label: o.label, c };
    });
    const schemeOpts = [
      { id: 'all', label: 'ALL', c: curBS ? ((curBS.exact || 0) + (curBS.upto || 0)) : (tier === 'all' ? total : null) },
      { id: 'exact', label: 'EXACT', c: curBS ? curBS.exact : null },
      { id: 'upto', label: 'UPTO', c: curBS ? curBS.upto : null }
    ];
    const filterDds = [
      {
        label: 'FACILITATOR', open: dd === 'conf',
        toggle: () => this.setState(s => ({ ddOpen: s.ddOpen === 'conf' ? null : 'conf' })),
        valueLabel: (confOpts.find(o => o.id === tier) || confOpts[0]).label,
        valueCountTxt: !af0 && (confOpts.find(o => o.id === tier) || confOpts[0]).c != null ? this.n((confOpts.find(o => o.id === tier) || confOpts[0]).c) : '',
        options: confOpts.map(o => ({
          label: o.label, countTxt: !af0 && o.c != null ? this.n(o.c) : '',
          pick: () => { this.setState({ ddOpen: null }); this.setTier(o.id); },
          bg: o.id === tier ? 'var(--ink)' : 'var(--panel)', fg: o.id === tier ? 'var(--panel)' : 'var(--ink)'
        }))
      },
      {
        label: 'SCHEME', open: dd === 'scheme',
        toggle: () => this.setState(s => ({ ddOpen: s.ddOpen === 'scheme' ? null : 'scheme' })),
        valueLabel: (schemeOpts.find(o => o.id === scheme) || schemeOpts[0]).label,
        valueCountTxt: !af0 && (schemeOpts.find(o => o.id === scheme) || schemeOpts[0]).c != null ? this.n((schemeOpts.find(o => o.id === scheme) || schemeOpts[0]).c) : '',
        options: schemeOpts.map(o => ({
          label: o.label, countTxt: !af0 && o.c != null ? this.n(o.c) : '',
          pick: () => { this.setState({ ddOpen: null }); this.setScheme(o.id); },
          bg: o.id === scheme ? 'var(--ink)' : 'var(--panel)', fg: o.id === scheme ? 'var(--panel)' : 'var(--ink)'
        }))
      }
    ];
    const af = this.state.addrFilter || null;
    const hasActiveFilter = tier !== 'all' || scheme !== 'all' || !!af;
    const activeCount = tier !== 'all' ? bc[tier] : (scheme !== 'all' ? bs[scheme] : total);
    const crossFilter = tier !== 'all' && scheme !== 'all';
    const filterResultTxt = af || crossFilter ? this.n(items.length) + (more ? '+' : '') + ' MATCHING' : (hasActiveFilter ? this.n(activeCount) + ' MATCHING' : this.n(total) + ' TOTAL');
    // facilitators page
    const facArr = facs || [];
    const attributed = facArr.reduce((a, f) => a + (f.stats?.totalPayments || 0), 0);
    const shareBase = Math.max(total, attributed + (bc['x402-shaped'] || 0)) || 1;
    let acc = 0; const segs = []; const legend = []; const donutSlices = []; const CIRC = 376.99;
    facArr.forEach((f, i) => {
      const cnt = f.stats?.totalPayments || 0; if (!cnt) return;
      const from = acc / shareBase * 100; acc += cnt; const to = acc / shareBase * 100;
      const color = this.PALETTE[i % this.PALETTE.length];
      segs.push(color + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%');
      donutSlices.push({
        color,
        dash: ((to - from) / 100 * CIRC).toFixed(2) + ' ' + CIRC.toFixed(2),
        off: (-(from / 100) * CIRC).toFixed(2),
        name: this.facName(f.displayName || f.id), count: cnt, pct: (to - from).toFixed(1) + '%'
      });
      legend.push({ name: this.facName(f.displayName || f.id), color, pctTxt: (cnt / shareBase * 100).toFixed(1) + '%' });
    });
    const unkCnt = bc['x402-shaped'] || 0;
    if (unkCnt) {
      const from = acc / shareBase * 100;
      donutSlices.push({
        color: '#9A9A90',
        dash: ((100 - from) / 100 * CIRC).toFixed(2) + ' ' + CIRC.toFixed(2),
        off: (-(from / 100) * CIRC).toFixed(2),
        name: 'UNATTRIBUTED', count: unkCnt, pct: (unkCnt / shareBase * 100).toFixed(1) + '%'
      });
    }
    const dh = this.state.facDonutHover != null ? donutSlices[this.state.facDonutHover] : null;
    donutSlices.forEach((sl, i) => {
      sl.enter = () => this.setState({ facDonutHover: i });
      sl.leave = () => this.setState({ facDonutHover: null });
    });
    if (unkCnt) {
      const from = acc / shareBase * 100;
      segs.push('#9A9A90 ' + from.toFixed(2) + '% 100%');
      legend.push({ name: 'unknown (x402-shaped)', color: '#9A9A90', pctTxt: (unkCnt / shareBase * 100).toFixed(1) + '%' });
    }
    const donutBg = segs.length ? 'conic-gradient(' + segs.join(',') + ')' : 'var(--stripe)';
    const colorOf = {}; facArr.forEach((f, i) => { colorOf[f.id] = this.PALETTE[i % this.PALETTE.length]; });
    const win30Of = {}; let unattr30 = 0;
    ((this.state.eco && this.state.eco.facilitators) || []).forEach(f => {
      if (f.facilitatorId) win30Of[f.facilitatorId] = (f.windows && f.windows['30d']) || 0;
      else unattr30 = (f.windows && f.windows['30d']) || 0;
    });
    const fsKey = this.state.facSortKey || 'payments';
    const fsVal = f => fsKey === 'buyers' ? (f.stats?.uniqueBuyers || 0)
      : fsKey === 'sellers' ? (f.stats?.uniqueSellers || 0)
      : fsKey === 'last' ? (f.stats?.lastPaymentAt ? new Date(f.stats.lastPaymentAt).getTime() : 0)
      : (f.stats?.totalPayments || 0);
    const monthYr = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase() : '—';
    const facEntries = facArr.slice().sort((a, b) => fsVal(b) - fsVal(a)).map(f => {
      const fv = (f.stats && f.stats.byAsset && f.stats.byAsset[0]) || null;
      const fvCode = fv ? (fv.assetCode || (fv.asset === 'native' ? 'XLM' : (fv.asset ? fv.asset.split(':')[0] : (this.codeFor(fv.assetContract) || '?')))) : '';
      const ok = f.verified && !f.lastError;
      const uptoOk = (f.uptoContracts || []).length > 0;
      return {
        unattributed: false,
        name: this.facName(f.displayName || f.id), color: colorOf[f.id],
        statusC: ok ? '#2FA36B' : '#D64570',
        statusT: f.lastError ? 'operator endpoint error: ' + f.lastError
          : !f.verified ? 'not verified'
          : 'verified, endpoint responding' + (f.lastSeenAt ? ' (checked ' + this.ago(f.lastSeenAt) + ' ago)' : ''),
        showBadges: true,
        uptoTxt: uptoOk ? 'UPTO ✓' : 'UPTO ✗',
        uptoBg: uptoOk ? '#2FA36B' : '#D64570',
        chips: (f.source === 'announce' ? 'SELF-ANNOUNCED' : 'SEEDED')
          + (f.stats && f.stats.firstPaymentAt ? ' · SINCE ' + monthYr(f.stats.firstPaymentAt) : ''),
        sharePct: ((f.stats?.totalPayments || 0) / shareBase * 100).toFixed(1) + '%',
        payTxt: this.n(f.stats?.totalPayments), w30Txt: this.n(win30Of[f.id] || 0),
        buyTxt: this.n(f.stats?.uniqueBuyers), sellTxt: this.n(f.stats?.uniqueSellers),
        volTxt: fv ? this.fmtCompact(Number(fv.total) / 1e7) + ' ' + fvCode : '—',
        lastTxt: f.stats?.lastPaymentAt ? this.ago(f.stats.lastPaymentAt) + ' ago' : '—',
        cursor: 'pointer',
        open: () => this.nav('facilitator/' + f.id),
        _sort: fsVal(f)
      };
    });
    if (unkCnt) {
      const uRow = {
        unattributed: true,
        name: 'UNATTRIBUTED', color: '#9A9A90',
        statusC: 'var(--line)', statusT: 'no operator claims these payments',
        showBadges: false, uptoTxt: '', uptoBg: 'transparent',
        chips: 'X402-SHAPED TRAFFIC',
        sharePct: (unkCnt / shareBase * 100).toFixed(1) + '%',
        payTxt: this.n(unkCnt), w30Txt: this.n(unattr30),
        buyTxt: '—', sellTxt: '—', volTxt: '—', lastTxt: '—',
        cursor: 'default', open: () => {},
        _sort: fsKey === 'payments' ? unkCnt : -1
      };
      const at = facEntries.findIndex(e => e._sort < uRow._sort);
      if (at < 0) facEntries.push(uRow); else facEntries.splice(at, 0, uRow);
    }
    let rk = 0;
    const facList = facEntries.map(e => ({ ...e, rank: e.unattributed ? '▨' : String(++rk).padStart(2, '0') }));
    const sortHdr = (key, label) => ({
      label: label + (fsKey === key ? ' ↓' : ''),
      pick: () => this.setState({ facSortKey: key }),
      fg: fsKey === key ? 'var(--ink)' : 'var(--mut)'
    });
    const facSortHdrs = [sortHdr('payments', 'PAYMENTS'), sortHdr('buyers', 'BUYERS'), sortHdr('sellers', 'SELLERS'), sortHdr('last', 'LAST SEEN')];
    // tx page
    const t = txData;
    const dConf = t ? (this.confMap()[t.confidence] || this.confMap()['x402-shaped']) : null;
    const uptoPct = t && t.ceiling && Number(t.ceiling) > 0 ? Math.min(100, Number(t.amount) / Number(t.ceiling) * 100).toFixed(1) + '%' : '0%';
    // address page
    const sellerPayments = addrSeller ? (addrSeller.payments || []) : [];
    const buyerItems = addrBuyerItems || [];
    const addrRows = (addrTab === 'seller' ? sellerPayments : buyerItems).map(p => this.mapRow(p));
    const sstats = addrSeller ? addrSeller.stats : null;
    // assets page (windowed via /stats?window=)
    const aWin = this.state.assetsWin || 'all';
    const aWS = this.state.assetsWinStats && this.state.assetsWinStats.window === aWin ? this.state.assetsWinStats.data : null;
    const aSrc = aWin === 'all' ? stats : aWS;
    const aTotal = aSrc ? aSrc.totalPayments || 0 : 0;
    const allAssets = aSrc ? (aSrc.byAsset || []) : [];
    const aPts = this.state.assetsTs ? (this.state.assetsTs.points || []) : [];
    const sparkOf = contract => {
      if (!aPts.length) return { bars: [], active: false };
      const counts = aPts.map(p => { const v = (p.volume || []).find(x => x.assetContract === contract); return v ? v.count : 0; });
      const mx = Math.max(1, ...counts);
      return {
        active: counts.some(c => c > 0),
        bars: counts.map(c => ({ h: (c > 0 ? Math.max(15, c / mx * 100) : 5) + '%', bg: c > 0 ? 'var(--acc)' : 'var(--line)' }))
      };
    };
    const assetPages = Math.max(1, Math.ceil(allAssets.length / 10));
    const assetPage = Math.min(this.state.assetPage || 0, assetPages - 1);
    const assetRows = allAssets.slice(assetPage * 10, assetPage * 10 + 10).map((a, i0) => { const i = assetPage * 10 + i0;
      const code = a.asset ? (a.asset === 'native' ? 'XLM' : a.asset.split(':')[0]) : (this.codeFor(a.assetContract) || '?');
      const sp = sparkOf(a.assetContract);
      return {
        rank: String(i + 1).padStart(2, '0'),
        code: code === '?' ? this.short(a.assetContract) : code,
        unnamed: code === '?',
        iconUrl: this.iconFor(code, a.asset), hasIcon: !!this.iconFor(code, a.asset), noIcon: !this.iconFor(code, a.asset),
        contract: a.assetContract, contractShort: a.assetContract.slice(0, 8) + '…' + a.assetContract.slice(-6),
        expertUrl: 'https://stellar.expert/explorer/' + this.expNet() + '/contract/' + a.assetContract,
        stopProp: (e) => e.stopPropagation(),
        copyContract: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.copy(a.assetContract); },
        open: () => this.nav('asset/' + a.assetContract),
        sharePct: aTotal ? Math.max(0.2, a.count / aTotal * 100).toFixed(1) + '%' : '0%',
        spark: sp.bars, hasSpark: sp.bars.length > 0,
        countTxt: this.n(a.count), volTxt: this.vol(a.total)
      };
    });
    const topA0 = allAssets[0] || null;
    const topA0Code = topA0 ? (topA0.asset === 'native' ? 'XLM' : (topA0.asset ? topA0.asset.split(':')[0] : (this.codeFor(topA0.assetContract) || this.short(topA0.assetContract)))) : '—';
    const activeCnt = aPts.length ? allAssets.filter(a => sparkOf(a.assetContract).active).length : null;
    return {
      routeFeed: route.name === 'feed', routeFacs: route.name === 'facs', routeFac: route.name === 'fac',
      routeTx: route.name === 'tx', routeAddr: route.name === 'addr', routeAssets: route.name === 'assets',
      routeSellers: route.name === 'sellers',
      routeEco: route.name === 'eco',
      navEcoBg: nb(route.name === 'eco'), navEcoFg: nf(route.name === 'eco'),
      goEco: () => this.nav('ecosystem'),
      ...this.ecoVals(),
      navSellBg: nb(route.name === 'sellers'), navSellFg: nf(route.name === 'sellers'),
      goSellers: () => this.nav('sellers'),
      sellersLoading: !!this.state.sellersLoading,
      sellerRows: (this.state.sellersLoading ? [] : (this.state.sellersData || [])).map((s, i) => {
        const topVol = (s.volume || [])[0];
        const domain = s.resource ? String(s.resource).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
        return {
          rank: String((this.state.sellersOffset || 0) + i + 1).padStart(2, '0'),
          name: s.serviceName || this.short(s.payTo),
          nameFg: s.serviceName ? 'var(--ink)' : 'var(--mut)',
          regTxt: s.registered ? 'BAZAAR' : 'ON-CHAIN',
          regBg: s.registered ? 'var(--acc)' : 'transparent',
          regFg: s.registered ? 'var(--onacc)' : 'var(--mut)',
          regBd: s.registered ? 'var(--acc)' : 'var(--line)',
          sub: (domain ? domain + ' · ' : '') + (s.serviceName ? this.short(s.payTo) : '') + (s.firstSeenAt ? (domain || s.serviceName ? ' · ' : '') + 'SINCE ' + new Date(s.firstSeenAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase() : ''),
          desc: s.description || '',
          payTxt: this.n(s.payments), buyTxt: this.n(s.uniqueBuyers),
          volTxt: topVol ? (topVol.totalDecimal != null ? this.fmtCompact(Number(topVol.totalDecimal)) : this.vol(topVol.total)) : '—',
          volCode: topVol ? (topVol.assetCode || this.codeFor(topVol.assetContract) || '') : '',
          volIcon: topVol ? this.iconFor(topVol.assetCode || this.codeFor(topVol.assetContract), topVol.asset) : '',
          volHasIcon: !!(topVol && this.iconFor(topVol.assetCode || this.codeFor(topVol.assetContract), topVol.asset)),
          lastTxt: s.lastSeenAt ? this.ago(s.lastSeenAt) + ' ago' : '—',
          open: () => this.nav('address/' + s.payTo)
        };
      }),
      sellersKpiTotalTxt: this.state.sellersKpiTotal != null ? this.n(this.state.sellersKpiTotal) : '…',
      sellersKpiBazaarTxt: this.state.sellersKpiBazaar != null ? this.n(this.state.sellersKpiBazaar) : '…',
      sellersKpi7dTxt: this.state.sellersKpi7d != null ? this.n(this.state.sellersKpi7d) : '…',
      sellersWinTabs: [['all', 'ALL TIME'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']].map(([id, label]) => ({
        label, pick: () => this.setSellersWin(id),
        bg: (this.state.sellersWin || 'all') === id ? 'var(--ink)' : 'var(--panel)',
        fg: (this.state.sellersWin || 'all') === id ? 'var(--panel)' : 'var(--ink)'
      })),
      sellersRegTabs: [['all', 'ALL'], ['bazaar', 'BAZAAR'], ['onchain', 'ON-CHAIN ONLY']].map(([id, label]) => ({
        label, pick: () => this.setSellersReg(id),
        bg: (this.state.sellersReg || 'all') === id ? 'var(--ink)' : 'var(--panel)',
        fg: (this.state.sellersReg || 'all') === id ? 'var(--panel)' : 'var(--ink)'
      })),
      sellersEmpty: !this.state.sellersLoading && (this.state.sellersData || []).length === 0 && !this.state.sellersErr,
      sellersErr: !!this.state.sellersErr && !this.state.sellersLoading,
      retrySellers: () => this.loadSellers(this.state.sellersOffset || 0),
      facsErr: !!this.state.facsErr && !facsLoading,
      retryFacs: () => this.loadFacs(),
      ecoErr: !!this.state.ecoErr && !this.state.ecoLoading && !this.state.eco,
      retryEco: () => { this._ecoAt = 0; this.loadEco(); },
      addrTabWord: addrTab === 'seller' ? 'a seller' : 'a buyer',
      sellersPageTxt: 'PAGE ' + (Math.floor((this.state.sellersOffset || 0) / 10) + 1) + ' / ' + Math.max(1, Math.ceil((this.state.sellersTotal || 0) / 10)),
      sellersPrevDisabled: (this.state.sellersOffset || 0) <= 0,
      sellersNextDisabled: (this.state.sellersOffset || 0) + 10 >= (this.state.sellersTotal || 0),
      sellersPrevCur: (this.state.sellersOffset || 0) > 0 ? 'pointer' : 'not-allowed',
      sellersNextCur: (this.state.sellersOffset || 0) + 10 < (this.state.sellersTotal || 0) ? 'pointer' : 'not-allowed',
      sellersPrevFg: (this.state.sellersOffset || 0) > 0 ? 'var(--ink)' : 'var(--line)',
      sellersNextFg: (this.state.sellersOffset || 0) + 10 < (this.state.sellersTotal || 0) ? 'var(--ink)' : 'var(--line)',
      sellersPrev: () => { const o = Math.max(0, (this.state.sellersOffset || 0) - 10); this.loadSellers(o); },
      sellersNext: () => { const o = (this.state.sellersOffset || 0) + 10; if (o < (this.state.sellersTotal || 0)) this.loadSellers(o); },
      navFeedBg: nb(route.name === 'feed'), navFeedFg: nf(route.name === 'feed'),
      navFacBg: nb(route.name === 'facs' || route.name === 'fac'), navFacFg: nf(route.name === 'facs' || route.name === 'fac'),
      navAssetBg: nb(route.name === 'assets' || route.name === 'asset'), navAssetFg: nf(route.name === 'assets' || route.name === 'asset'),
      goFeed: () => this.nav(''), goFacs: () => this.nav('facilitators'), goAssets: () => this.nav('assets'),
      navClass: 'r-nav' + (this.state.menuOpen ? ' r-open' : ''),
      menuIcon: this.state.menuOpen ? '✕' : '☰',
      toggleMenu: () => this.setState(s => ({ menuOpen: !s.menuOpen })),
      netMenuOpen: this.state.netMenuOpen || false,
      toggleNetMenu: () => this.setState(s => ({ netMenuOpen: !s.netMenuOpen })),
      networkLabel: this.state.network === 'stellar:pubnet' ? 'MAINNET' : 'TESTNET',
      netOptions: [
        { id: 'stellar:testnet', label: 'TESTNET' },
        { id: 'stellar:pubnet', label: 'MAINNET' }
      ].map(o => ({
        label: o.label, soon: false,
        pick: () => this.setNetwork(o.id),
        cursor: 'pointer',
        opacity: o.disabled ? '.55' : '1',
        bg: o.id === this.state.network ? 'var(--ink)' : 'var(--panel)',
        fg: o.id === this.state.network ? 'var(--panel)' : 'var(--ink)',
        hoverBg: o.disabled ? 'var(--panel)' : 'var(--acc)',
        hoverFg: o.disabled ? 'var(--ink)' : 'var(--onacc)'
      })),
      q, setQ: (e) => this.setState({ q: e.target.value, searchErr: false }),
      onSearchKey: (e) => { if (e.key === 'Enter') this.doSearch(); },
      searchBd: searchErr ? 'var(--acc)' : 'var(--line)',
      lastAgoUp: stats && stats.lastPaymentAt ? this.ago(stats.lastPaymentAt).toUpperCase() + ' AGO' : '…',
      // feed
      loading, more, tabs, schemeTabs, filterDds, hasActiveFilter, filterResultTxt,
      clearFilters: () => this.setState({ tier: 'all', scheme: 'all', addrFilter: null, items: [], cursor: null, ddOpen: null }, () => { this.syncFeedHash(); this.load(); }),
      hasAddrFilter: !!af,
      addrFilterRole: af ? af.role.toUpperCase() : '',
      addrFilterShort: af ? this.short(af.addr) : '',
      addrFilterFull: af ? af.addr : '',
      openAddrPage: () => { if (af) this.nav('address/' + af.addr); },
      clearAddrFilter: () => this.setState({ addrFilter: null, items: [], cursor: null }, () => { this.syncFeedHash(); this.load(); }),
      rows: items.map(p => this.mapRow(p)),
      totalTxt: stats ? this.n(total) : '…', buyersTxt: stats ? this.n(stats.uniqueBuyers) : '…',
      sellersTxt: stats ? this.n(stats.uniqueSellers) : '…',
      usdcVolTxt: topA ? this.fmtCompact(Number(topA.total) / 1e7) : '…',
      topAssetKpiLabel: topA ? 'TOP ASSET · ' + topACode : 'TOP ASSET',
      topAssetKpiCode: topACode ? topACode + ' SETTLED' : '',
      topAssetKpiIcon: topA ? this.iconFor(topACode, topA.asset) : '',
      topAssetKpiHasIcon: !!(topA && this.iconFor(topACode, topA.asset)),
      pctRail: pct('rail402'), pctVer: pct('verified-facilitator'), pctShaped: pct('x402-shaped'),
      loadMore: () => this.loadMore(),
      newCount: (this.state.pendingNew || []).length ? this.n((this.state.pendingNew || []).length) : '',
      hasNew: (this.state.pendingNew || []).length > 0,
      revealNew: () => this.setState(s => {
        const cap = Math.max(10, Math.ceil(s.items.length / 10) * 10);
        return { items: [...(s.pendingNew || []), ...s.items].slice(0, cap), pendingNew: [] };
      }),
      feedEmpty: !loading && items.length === 0 && !this.state.feedErr,
      feedErr: !!this.state.feedErr && !loading,
      retryFeed: () => this.load(),
      // facilitators
      facs: facList, facsLoading, donutBg, shareLegend: legend,
      facHdrPay: facSortHdrs[0], facHdrBuy: facSortHdrs[1], facHdrSell: facSortHdrs[2], facHdrLast: facSortHdrs[3],
      donutTotalTxt: this.fmtCompact(total),
      donutSlices,
      donutHoverOn: !!dh,
      donutIdleOn: !dh,
      dhName: dh ? dh.name : '', dhColor: dh ? dh.color : '',
      dhCount: dh ? this.n(dh.count) : '', dhPct: dh ? dh.pct : '',
      facCountTxt: facs ? this.n(facArr.length) : '…',
      facVerCountTxt: facs ? this.n(facArr.filter(f => f.verified).length) : '…',
      facAttrTxt: facs ? this.n(attributed) : '…',
      facUnknownTxt: this.n(unkCnt),
      // facilitator detail
      facLoading, facReady: !!facData, facMore, loadMoreFac: () => this.loadMoreFac(),
      facName: facData ? this.facName(facData.displayName || facData.id) : '',
      facVTxt: facData && facData.verified ? 'VERIFIED' : 'UNVERIFIED',
      facVBg: facData && facData.verified ? 'var(--ink)' : 'transparent',
      facVFg: facData && facData.verified ? 'var(--panel)' : 'var(--mut)',
      facSource: facData ? (facData.source || '—').toUpperCase() : '',
      facUrl: facData ? facData.baseUrl : '#', facUrlTxt: facData && facData.baseUrl ? facData.baseUrl.replace('https://', '') : '',
      facPayTxt: facData ? this.n(facData.stats?.totalPayments) : '—',
      facSchemeTxt: facData && facData.stats ? this.n(facData.stats.byScheme?.exact || 0) + ' / ' + this.n(facData.stats.byScheme?.upto || 0) : '—',
      facBuyTxt: facData ? this.n(facData.stats?.uniqueBuyers) : '—',
      facSellTxt: facData ? this.n(facData.stats?.uniqueSellers) : '—',
      facLastTxt: facData && facData.stats?.lastPaymentAt ? this.ago(facData.stats.lastPaymentAt) : '—',
      facSigners: facData ? (facData.signers || []).map(s => ({ short: this.short(s), full: s })) : [],
      facUpto: facData ? (facData.uptoContracts || []).map(s => ({ short: this.short(s), full: s })) : [],
      facHasUpto: !!(facData && facData.uptoContracts && facData.uptoContracts.length),
      facRows: facData ? (facData.payments || []).map(p => this.mapRow(p)) : [],
      // tx page
      txLoading, txReady: !!t, txErr: !!txErr,
      txErrCode: txErr ? (txErr.code || 'error') : '', txErrReason: txErr ? (txErr.reason || '') : '',
      retryTx: () => this.loadTx(route.arg),
      txHashShort: route.name === 'tx' && route.arg ? route.arg : '',
      dAmt: t ? t.amountDecimal : '', dCeil: t ? t.ceilingDecimal : '', dUptoPct: uptoPct,
      dAsset: t ? (t.assetCode || this.codeFor(t.assetContract) || (t.assetContract ? t.assetContract.slice(0, 6) + '…' : '')) : '',
      dIconUrl: t ? this.iconFor(t.assetCode || this.codeFor(t.assetContract), t.asset) : '',
      dHasIcon: !!(t && this.iconFor(t.assetCode || this.codeFor(t.assetContract), t.asset)),
      dIsUpto: !!(t && t.scheme === 'upto' && t.ceilingDecimal),
      dScheme: t ? t.scheme.toUpperCase() : '',
      dConfLabel: dConf ? dConf.label : '', dConfFg: dConf ? dConf.fg : '', dConfBg: dConf ? dConf.bg : '', dConfBd: dConf ? dConf.bd : '',
      dHash: t ? t.txHash : '', dLink: t ? 'https://stellar.expert/explorer/' + this.expNet() + '/tx/' + t.txHash : '#',
      dMultiOp: !!(t && t.payments && t.payments.length > 1), dOpCount: t && t.payments ? t.payments.length : 1,
      dSections: t ? this.txSections(t) : [],
      dTechRows: t ? (this._techRows || []) : [],
      techOpen: !!this.state.techOpen,
      toggleTech: () => this.setState(s => ({ techOpen: !s.techOpen })),
      techBtnLabel: this.state.techOpen ? 'TECHNICAL DETAILS ▲' : 'TECHNICAL DETAILS ▼',
      dAgo: t && t.closedAt ? this.ago(t.closedAt).toUpperCase() : '',
      dConfShort: t ? ({
        'rail402': 'ATTRIBUTION IS CERTAIN.',
        'verified-facilitator': 'A VERIFIED FACILITATOR. ATTRIBUTION IS CERTAIN.',
        'x402-shaped': 'STRUCTURALLY X402, BUT NO REGISTERED FACILITATOR CLAIMS IT.'
      }[t.confidence] || '') : '',
      dGoFac: () => { if (t && t.facilitator) this.nav('facilitator/' + t.facilitator.id); },
      dFacCursor: t && t.facilitator ? 'pointer' : 'default',
      dGoAsset: () => { if (t && t.assetContract) this.nav('asset/' + t.assetContract); },
      dSteps: t ? (() => {
        const code = t.assetCode || this.codeFor(t.assetContract) || 'tokens';
        const amt = t.amountDecimal + ' ' + code;
        const fee = t.feeChargedStroops ? (Number(t.feeChargedStroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, '') + ' XLM' : null;
        const dom = t.resource ? String(t.resource).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
        const facN = t.facilitator ? this.facName(t.facilitator.displayName) : null;
        const feeSelf = t.feeSource && t.buyer && t.feeSource === t.buyer;
        const P = v => ({ t: v, w: 400, deco: 'none', fg: 'var(--mut)' });
        const E = v => ({ t: v, w: 700, deco: 'none', fg: 'var(--ink)' });
        const sigParts = t.sigExpirationLedger ? [
          P(', valid until ledger '), E(this.n(t.sigExpirationLedger)),
          ...(t.ledger != null ? [P(' (settled at ledger '), E(this.n(t.ledger)),
            ...(Number(t.sigExpirationLedger) > Number(t.ledger) ? [P(', ' + this.n(Number(t.sigExpirationLedger) - Number(t.ledger)) + ' ledgers before expiry')] : []), P(')')] : [])
        ] : [];
        const feeParts = fee
          ? (feeSelf ? [P('The buyer paid its own network fee of '), E(fee), P('.')]
            : t.feeSource ? [P('The network fee of '), E(fee), P(' was sponsored by '), E(this.short(t.feeSource)), P(', not the buyer, so the agent paid nothing beyond the price.')]
            : [P('The network fee was '), E(fee), P('.')])
          : [];
        const EXB = 'https://stellar.expert/explorer/' + this.expNet();
        const mk = (n, title, parts, onchain, proof) => ({
          n, title, parts,
          tag: onchain ? 'PROVEN ON CHAIN' : 'PROTOCOL STEP',
          tagFg: onchain ? 'var(--acc)' : 'var(--mut)',
          mBg: onchain ? 'var(--acc)' : 'transparent',
          mFg: onchain ? 'var(--onacc)' : 'var(--mut)',
          mBd: onchain ? 'var(--acc)' : 'var(--line)',
          pShow: !!proof, pHref: proof ? proof.href : '#', pLabel: proof ? proof.label : ''
        });
        return [
          mk('01', 'PRICE QUOTED · HTTP 402', [
            P('The seller'),
            ...(t.serviceName ? [P(' ('), E(t.serviceName), P(')')] : []),
            ...(dom ? [P(' at '), E(dom)] : []),
            P(' answered the agent\u2019s request with '), E('402 Payment Required'), P(' and named its price of '), E(amt), P('.')
          ], false),
          mk('02', 'AUTHORIZATION SIGNED', t.scheme === 'upto' && t.ceilingDecimal
            ? [P('The buyer agent signed a '), E('metered (upto)'), P(' authorization with a ceiling of '), E(t.ceilingDecimal + ' ' + code), ...sigParts, P('. Actual usage settled: '), E(amt), P('.')]
            : [P('The buyer agent signed an '), E('exact'), P(' authorization for '), E(amt), ...sigParts, P('.')], false),
          mk('03', 'SUBMITTED FOR SETTLEMENT', [
            ...(facN
              ? [E(facN), P(' verified the authorization and submitted it on chain'), ...(t.txSource ? [P(' from '), E(this.short(t.txSource))] : []), P('. ')]
              : [P('An '), E('unidentified operator'), P(' submitted the payment on chain'), ...(t.txSource ? [P(' from '), E(this.short(t.txSource))] : []), P('. No registered facilitator claims it. ')]),
            ...feeParts
          ], true, t.txHash ? { href: EXB + '/tx/' + t.txHash, label: 'SEE PROOF ↗' } : null),
          mk('04', 'SETTLED ON CHAIN', [
            E(amt), P(' was delivered to the seller in ledger '), E(this.n(t.ledger)),
            ...(t.closedAt ? [P(' at '), E(new Date(t.closedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC'))] : []),
            P('. Final and irreversible.')
          ], true, t.txHash ? { href: EXB + '/tx/' + t.txHash, label: 'SEE DELIVERY PROOF ↗' } : null)
        ];
      })() : [],
      dHasService: !!(t && (t.serviceName || t.resource)),
      dServiceName: t && (t.serviceName || t.resource)
        ? ((t.serviceName || '') + (t.resource ? (t.serviceName ? ' · ' : '') + String(t.resource).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '')).toUpperCase()
        : '',
      dPayments: t && t.payments && t.payments.length > 1 ? t.payments.map((p, i) => ({
        idx: String(i + 1).padStart(2, '0'),
        buyer: this.short(p.buyer), seller: this.short(p.seller),
        scheme: (p.scheme || '').toUpperCase(),
        amt: p.amountDecimal, code: p.assetCode || this.codeFor(p.assetContract) || (p.assetContract ? p.assetContract.slice(0, 4) + '…' : ''),
        goBuyer: () => this.nav('address/' + p.buyer), goSeller: () => this.nav('address/' + p.seller)
      })) : [],
      dBuyerShort: t ? this.short(t.buyer) : '', dSellerShort: t ? this.short(t.seller) : '',
      dBuyerKind: t && t.buyer && t.buyer[0] === 'C' ? '· SMART-CONTRACT' : '',
      dGoBuyer: () => { if (t) this.nav('address/' + t.buyer); },
      dGoSeller: () => { if (t) this.nav('address/' + t.seller); },
      dCopyBuyer: () => { if (t) this.copy(t.buyer); },
      dCopySeller: () => { if (t) this.copy(t.seller); },
      dBuyerExpert: t && t.buyer ? 'https://stellar.expert/explorer/' + this.expNet() + '/' + (t.buyer[0] === 'C' ? 'contract/' : 'account/') + t.buyer : '#',
      dSellerExpert: t && t.seller ? 'https://stellar.expert/explorer/' + this.expNet() + '/' + (t.seller[0] === 'C' ? 'contract/' : 'account/') + t.seller : '#',
      dSettledTxt: t ? (t.facilitator ? this.facName(t.facilitator.displayName).toUpperCase() : 'UNKNOWN FACILITATOR') : '',
      copyHash: () => this.copy(t ? t.txHash : ''),
      copyLabel: copied ? 'COPIED ✓' : 'COPY ⧉',
      toggleRaw: () => this.toggleRaw(),
      rawBtnLabel: rawOpen ? 'HIDE RAW TX ▲' : 'INSPECT RAW TX ▼', rawOpen,
      rawTxt: raw ? JSON.stringify(raw, null, 2) : '',
      // address page
      addr: route.name === 'addr' ? route.arg : '',
      addrIsContract: route.name === 'addr' && route.arg && route.arg[0] === 'C',
      copyAddr: () => this.copy(route.arg || ''),
      addrLoading,
      addrHasService: !!(addrSeller && addrSeller.serviceName),
      addrServiceName: addrSeller ? (addrSeller.serviceName || '') : '',
      addrHasResource: !!(addrSeller && addrSeller.resource), addrResource: addrSeller ? (addrSeller.resource || '#') : '#',
      addrHasDesc: !!(addrSeller && addrSeller.description), addrDesc: addrSeller ? (addrSeller.description || '') : '',
      pickSellerTab: () => this.setState({ addrTab: 'seller' }, () => this.syncAddrMore()),
      pickBuyerTab: () => this.setState({ addrTab: 'buyer' }, () => this.syncAddrMore()),
      tabSellerBg: nb(addrTab === 'seller'), tabSellerFg: nf(addrTab === 'seller'),
      tabBuyerBg: nb(addrTab === 'buyer'), tabBuyerFg: nf(addrTab === 'buyer'),
      addrSellerCntTxt: sstats ? this.n(sstats.totalPayments) : (addrLoading ? '…' : '0'),
      addrBuyerCntTxt: addrBuyerItems ? (addrBuyerItems.length >= 20 ? this.n(addrBuyerItems.length) + '+' : this.n(addrBuyerItems.length)) : (addrLoading ? '…' : '0'),
      addrShowSellerStats: addrTab === 'seller' && !!sstats,
      addrPayTxt: sstats ? this.n(sstats.totalPayments) : '—',
      addrBuyTxt: sstats ? this.n(sstats.uniqueBuyers) : '—',
      addrSchemeTxt: sstats ? this.n(sstats.byScheme?.exact || 0) + ' / ' + this.n(sstats.byScheme?.upto || 0) : '—',
      addrLastTxt: sstats && sstats.lastPaymentAt ? this.ago(sstats.lastPaymentAt) : '—',
      addrSinceTxt: sstats && sstats.firstPaymentAt ? new Date(sstats.firstPaymentAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase() : '—',
      addrRows, addrMore, loadMoreAddr: () => this.loadMoreAddr(),
      addrEmpty: !addrLoading && addrRows.length === 0,
      // asset detail page
      ...(() => {
        const ad = this.state.assetD;
        const st = ad ? ad.stats || {} : {};
        const adCode = ad ? (ad.assetCode || this.codeFor(ad.assetContract) || this.short(ad.assetContract)) : '';
        const named = !!(ad && (ad.assetCode || this.codeFor(ad.assetContract)));
        const icon = ad ? this.iconFor(adCode, ad.asset) : '';
        const wRow = k => {
          const w = ad && ad.windows && ad.windows[k] ? ad.windows[k] : {};
          return { k: k.toUpperCase(), pay: this.n(w.payments || 0), buyers: this.n(w.uniqueBuyers || 0), sellers: this.n(w.uniqueSellers || 0), vol: w.totalDecimal != null ? this.fmtCompact(Number(w.totalDecimal)) + ' ' + adCode : '—' };
        };
        const err = this.state.assetDErr;
        return {
          routeAsset: route.name === 'asset',
          adLoading: !!this.state.assetDLoading,
          adErr: !!err && !this.state.assetDLoading,
          adErrCode: err ? (err.code || 'error') : '', adErrReason: err ? (err.reason || '') : '',
          retryAsset: () => this.loadAsset(route.arg),
          adReady: !!ad,
          adCode, adNamed: named, adUnnamed: !!ad && !named,
          adIcon: icon, adHasIcon: !!icon, adNoIcon: !icon,
          adContract: ad ? ad.assetContract : (route.name === 'asset' ? route.arg : ''),
          adCopy: () => this.copy(ad ? ad.assetContract : route.arg),
          adExpert: 'https://stellar.expert/explorer/' + this.expNet() + '/contract/' + (ad ? ad.assetContract : route.arg || ''),
          adEco: () => this.nav('ecosystem?asset=' + encodeURIComponent(ad ? ad.assetContract : route.arg)),
          adPayTxt: ad ? this.n(st.totalPayments) : '—',
          adVolTxt: ad && st.totalDecimal != null ? this.fmtCompact(Number(st.totalDecimal)) : '—',
          adVolCode: adCode ? adCode + ' SETTLED' : '',
          adBuyTxt: ad ? this.n(st.uniqueBuyers) : '—',
          adSellTxt: ad ? this.n(st.uniqueSellers) : '—',
          adSinceTxt: st.firstPaymentAt ? new Date(st.firstPaymentAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase() : '—',
          adLastTxt: st.lastPaymentAt ? this.ago(st.lastPaymentAt).toUpperCase() + ' AGO' : '—',
          adWindows: ad ? [wRow('24h'), wRow('7d'), wRow('30d')] : [],
          adRows: ad ? (ad.payments || []).map(p => this.mapRow(p)) : [],
          adMore: !!this.state.assetDMore,
          loadMoreAsset: () => this.loadMoreAsset()
        };
      })(),
      // assets
      assetRows,
      assetsKpiCountTxt: aSrc ? this.n(allAssets.length) : '…',
      assetsWinLoading: aWin !== 'all' && !aWS,
      assetsWinTabs: [['all', 'ALL TIME'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']].map(([id, label]) => ({
        label, pick: () => this.setAssetsWin(id),
        bg: aWin === id ? 'var(--ink)' : 'var(--panel)',
        fg: aWin === id ? 'var(--panel)' : 'var(--ink)'
      })),
      assetsKpiTopTxt: topA0Code,
      assetsKpiTopSub: topA0 && aTotal ? this.n(topA0.count) + ' payments (' + Math.round(topA0.count / aTotal * 100) + '%)' : '',
      assetsKpiActiveTxt: activeCnt != null ? this.n(activeCnt) : '…',
      assetPageTxt: 'PAGE ' + (assetPage + 1) + ' / ' + assetPages,
      assetHasPrev: assetPage > 0, assetHasNext: assetPage < assetPages - 1,
      assetPrev: () => this.setState({ assetPage: Math.max(0, assetPage - 1) }, () => this.syncAssetsHash()),
      assetNext: () => this.setState({ assetPage: Math.min(assetPages - 1, assetPage + 1) }, () => this.syncAssetsHash()),
      assetPrevDisabled: !(assetPage > 0), assetNextDisabled: !(assetPage < assetPages - 1),
      assetPrevCur: assetPage > 0 ? 'pointer' : 'not-allowed', assetNextCur: assetPage < assetPages - 1 ? 'pointer' : 'not-allowed',
      assetPrevFg: assetPage > 0 ? 'var(--ink)' : 'var(--line)', assetNextFg: assetPage < assetPages - 1 ? 'var(--ink)' : 'var(--line)'
    };
  }

  render() {
    return <Shell v={this.renderVals()} />;
  }
}

Logic.defaultProps = { pollSeconds: 12, accent: '#FF4D00' };
