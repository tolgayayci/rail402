/**
 * Testnet-shaped identities of the fixtures. They name no real account: the Bazaar fixtures use them,
 * and recorded runs are rewritten to them (record.ts), so every fixture reads like one Playground.
 */
export const IDS = Object.freeze({
  buyer: "GBBUST7CLPILF6HWXBQPBU6N7Q5FXF65JVVXZW7YPPIO6RI7JSSRTYQO",
  demoPayTo: "GDFLALQBMOBUWZ62VF2FTZ7ZAQXPFPJS7KYAKZMDLF4NKALQ4ESZK3TH",
  playgroundPayTo: "GB7KINVKZ6HC5QI5USK2CEQJ6WUUUZIIV2ZTGABUIVGPFHL2SC6LXVT6",
  feeSigner: "GD4QMGUQAIHFP46CWPGQR52WJVBTWUO4NDROCYGTLRZ6I4OYX5MNJLM6",
  uptoAuthority: "GBHNHSRL5MRHJJSB3ZVBBVCUIVYNGI3KQIVBJJEKQPQN3GWKVRD3HBHS",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  uptoContract: "CCQPG6UZIIARBN5MXZBVFGQKFHX37CPKG5R3CIZKGBECJOFFYT35GT6P",
  test6: "CBE2OEQFOX3JBQ5Y24DVKFRIJG4DJ5VPGMHRUSNQOJOI25X4XBYS2UDD",
  tx: Object.freeze({
    pay: "4be502db566556c2e5e75e054331c24434c740cee8774e1b3f50e7cd4d5c826d",
    payInner: "93b66c12ab7ec90fdf475e2b3379ddf61178f9e56c3b4a10b782aa73dbf060d7",
    upto: "08cd7de51cb4e7b2458dc1b6c1d518e1090221d4834cf0bc52d9fb25e8a5edc2",
    uptoInner: "05b15d24380e4777a3448ccfcf0da8e1349120d4a7f2cbc036ba26a7320c101c",
    agent: "0d35fb44891a4cf7a582b7ec18b167095bc66c4bc01da526f98f86b6fe395d72",
    agentInner: "166ef3d352c5accbff68ec07d873e4a30e405e4055fee1953fde27658d395ffe",
    sell: "8804d3d08fe4c3cf7086d38bd9055387f12788df916f96e55315b3ea1956c517",
    sellInner: "f727c130681c9723ec8c14543777ee7521d3ffcb7b649c36176e4250d67585a5",
  }),
  listing: Object.freeze({
    weather: "lst_01JC8W3F0WEATHER0000000001",
    forecast: "lst_01JC8W3F0FORECAST000000002",
    history: "lst_01JC8W3F0HISTORY0000000003",
    translate: "lst_01JC8W3F0TRANSLATE00000004",
    airQuality: "lst_01JC8W3F0AIRQUALITY0000005",
    sample: "lst_01JC8W3F0SAMPLE000000000006",
  }),
});

export const URLS = Object.freeze({
  public: "https://playground.rail402.dev",
  demoSeller: "https://demo.rail402.dev",
  facilitator: "https://testnet.rail402.dev",
  docs: "https://docs.rail402.dev",
});
