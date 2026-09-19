(() => {
  'use strict';

  const slot = document.getElementById('adSlot');
  const mount = document.getElementById('adMount');
  if (!slot || !mount || window.__mrRemovalAdLoaded) return;

  // 728px banner needs breathing room inside the app shell, so tablets and
  // narrow desktop windows use the 320px mobile creative too.
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const config = mobile
    ? {
        tagId: 'c353bd1916008a19171a147b0897bad5',
        interstitialTagId: 'eef4b35464b745088a51572fd8ff1991',
        width: 320,
        height: 50,
      }
    : {
        tagId: 'fbd3a0fdfddc2a55a376d0425236dccb',
        interstitialTagId: '1c5183ee57000dec81e78da690573a90',
        width: 728,
        height: 90,
      };

  window.__mrRemovalAdLoaded = true;
  // 自動挿入・オーバーレイは使わず、固定バナーと端末別インタースティシャルだけを渡す。
  delete window.admaxoverlay;
  delete window.admaxaction;

  const bannerId = `admax-banner-mr-removal-${mobile ? 'mobile' : 'desktop'}`;
  const banner = document.createElement('div');
  banner.id = bannerId;
  banner.style.display = 'inline-block';
  banner.style.width = `${config.width}px`;
  banner.style.height = `${config.height}px`;
  banner.style.maxWidth = '100%';
  mount.appendChild(banner);

  window.admaxbanner = {
    admax_id: bannerId,
    tag_id: config.tagId,
    type: 'b',
    width: config.width,
    height: config.height,
  };
  window.admaxaction = {
    tag_id: config.interstitialTagId,
    type: 'a',
    width: null,
    height: null,
    action: 'interstitial',
  };
  slot.classList.toggle('is-mobile', mobile);

  const script = document.createElement('script');
  script.src = 'https://adm.shinobi.jp/st/s.js';
  script.async = true;
  script.charset = 'utf-8';
  script.onerror = () => slot.classList.add('hidden');
  document.head.appendChild(script);
})();
