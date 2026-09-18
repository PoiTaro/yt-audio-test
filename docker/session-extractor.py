import asyncio
import dataclasses
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp
from typing import Optional

import nodriver

logger = logging.getLogger('extractor')

TEST_URLS = (
    'https://www.youtube.com/embed/jNQXAC9IVRw?autoplay=1',
    'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?autoplay=1',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
)


@dataclass
class TokenInfo:
    updated: int
    potoken: str
    visitor_data: str

    def to_json(self) -> str:
        return json.dumps(dataclasses.asdict(self))


class PotokenExtractor:
    def __init__(self, loop: asyncio.AbstractEventLoop,
                 update_interval: float = 3600,
                 browser_path: Optional[Path] = None) -> None:
        self.update_interval = update_interval
        self.browser_path = browser_path
        self.profile_path = mkdtemp()
        self._loop = loop
        self._token_info = None
        self._ongoing_update = asyncio.Lock()
        self._extraction_done = asyncio.Event()
        self._update_requested = asyncio.Event()

    def get(self) -> Optional[TokenInfo]:
        return self._token_info

    async def run_once(self) -> Optional[TokenInfo]:
        await self._update()
        return self.get()

    async def run(self) -> None:
        await self._update()
        while True:
            try:
                await asyncio.wait_for(self._update_requested.wait(), timeout=self.update_interval)
            except asyncio.TimeoutError:
                pass
            await self._update()
            self._update_requested.clear()

    def request_update(self) -> bool:
        if self._ongoing_update.locked() or self._update_requested.is_set():
            return False
        self._loop.call_soon_threadsafe(self._update_requested.set)
        return True

    @staticmethod
    def _extract_token(request: nodriver.cdp.network.Request) -> Optional[TokenInfo]:
        try:
            post_data_json = json.loads(request.post_data)
            visitor_data = post_data_json['context']['client']['visitorData']
            potoken = post_data_json['serviceIntegrityDimensions']['poToken']
        except (json.JSONDecodeError, TypeError, KeyError):
            return None
        return TokenInfo(updated=int(time.time()), potoken=potoken, visitor_data=visitor_data)

    async def _update(self) -> None:
        try:
            await asyncio.wait_for(self._perform_update(), timeout=600)
        except asyncio.TimeoutError:
            logger.error('update failed: hard limit timeout exceeded')

    async def _perform_update(self) -> None:
        if self._ongoing_update.locked():
            return
        async with self._ongoing_update:
            logger.info('update started')
            self._extraction_done.clear()
            browser = await nodriver.start(
                headless=False,
                browser_executable_path=self.browser_path,
                user_data_dir=self.profile_path,
                no_sandbox=True,
            )
            try:
                tab = browser.main_tab
                tab.add_handler(nodriver.cdp.network.RequestWillBeSent, self._send_handler)
                for url in TEST_URLS:
                    logger.info('trying player route: %s', url.split('?')[0])
                    await tab.get(url)
                    try:
                        player = await tab.select('#movie_player', 8)
                        await player.click()
                    except asyncio.TimeoutError:
                        logger.warning('player element missing at %s', tab.url)
                    try:
                        await asyncio.wait_for(self._extraction_done.wait(), timeout=12)
                        logger.info('update was successful')
                        return
                    except asyncio.TimeoutError:
                        logger.warning('no player request captured for route')
                logger.warning('all player routes failed')
            finally:
                await tab.close()
                browser.stop()

    async def _send_handler(self, event: nodriver.cdp.network.RequestWillBeSent) -> None:
        if event.request.method != 'POST' or '/youtubei/v1/player' not in event.request.url:
            return
        token_info = self._extract_token(event.request)
        if token_info is None:
            return
        logger.info('new token captured')
        self._token_info = token_info
        self._extraction_done.set()
