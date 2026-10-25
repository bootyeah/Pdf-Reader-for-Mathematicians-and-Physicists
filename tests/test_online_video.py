"""Online video resolver and real reader HTTP contract; no external network."""
import copy
import json
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from app.services import online_video_service as online

BV = 'BV18j7NzZEve'
URL = 'https://www.bilibili.com/video/' + BV + '/'
COURSE = {'code': 0, 'data': {'bvid': BV, 'aid': 123, 'title': '课程', 'pages': [
    {'cid': 101, 'page': 1, 'part': '第 10 讲（网站第一集）'},
    {'cid': 102, 'page': 2, 'part': '第 2 讲（网站第二集）'},
    {'cid': 103, 'page': 3, 'part': '<第三讲>'},
]}}


class Reader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class OnlineVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Reader)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, data, headers=None):
        request = urllib.request.Request(self.base + '/api/online-video',
            data=json.dumps(data).encode(), headers=headers or {})
        try:
            response = self.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_multipart_preserves_site_order_and_start_page(self):
        with patch.object(online, '_fetch', return_value=COURSE) as fetch:
            status, data = self.request({'url': URL + '?p=2&spm_id_from=tracking'})
        self.assertEqual(status, 200)
        self.assertEqual([v['name'] for v in data['videos']], [p['part'] for p in COURSE['data']['pages']])
        self.assertEqual(data['selected'], data['videos'][1]['url'])
        self.assertIn('cid=102', data['selected'])
        self.assertIn('p=2', data['selected'])
        self.assertEqual(data['videos'][0]['kind'], 'bilibili')
        fetch.assert_called_once_with('https://api.bilibili.com/x/web-interface/view?bvid=' + BV)

    def test_collection_order_selected_and_duplicates(self):
        doc = copy.deepcopy(COURSE)
        doc['data']['pages'] = doc['data']['pages'][:1]
        episodes = [
            {'bvid': 'BV1B7411m7LV', 'cid': 20, 'title': 'Z first'},
            {'bvid': BV, 'cid': 101, 'title': 'Current'},
            {'bvid': 'BV1sT4y1Z7D8', 'cid': 30, 'title': 'A last'},
        ]
        doc['data']['ugc_season'] = {'sections': [{'episodes': episodes}, {'episodes': episodes[:1]}]}
        with patch.object(online, '_fetch', return_value=doc):
            data = online.resolve(URL)
        self.assertEqual([v['name'] for v in data['videos']], ['Z first', '课程', 'A last'])
        self.assertEqual(data['selected'], data['videos'][1]['url'])

    def test_collection_without_current_does_not_play_wrong_video(self):
        doc = copy.deepcopy(COURSE)
        doc['data']['pages'] = doc['data']['pages'][:1]
        doc['data']['ugc_season'] = {'sections': [{'episodes': [{'bvid': 'BV1B7411m7LV', 'title': 'Other'}]}]}
        with patch.object(online, '_fetch', return_value=doc):
            data = online.resolve(URL)
        self.assertEqual(len(data['videos']), 1)
        self.assertIn(BV, data['selected'])

    def test_short_link_and_legacy_id(self):
        with patch.object(online, '_fetch', side_effect=[URL + '?p=3', COURSE]) as fetch:
            result = online.resolve('https://b23.tv/example')
        self.assertIn('cid=103', result['selected'])
        self.assertEqual(fetch.call_args_list[0].kwargs, {'json_body': False})
        with patch.object(online, '_fetch', return_value=COURSE) as fetch:
            online.resolve('https://www.bilibili.com/video/av123/?p=2')
        fetch.assert_called_once_with('https://api.bilibili.com/x/web-interface/view?aid=123')
        with patch.object(online, '_fetch', return_value=COURSE):
            data = online.resolve('https://player.bilibili.com/player.html?bvid=' + BV + '&p=3')
        self.assertIn('cid=103', data['selected'])

    def test_direct_link_is_never_fetched_by_server(self):
        url = 'https://media.example/lesson%202.MP4?signature=keep%2Bme'
        with patch.object(online, '_fetch') as fetch:
            data = online.resolve(url)
        fetch.assert_not_called()
        self.assertEqual(data['selected'], url)
        self.assertEqual(data['videos'][0]['name'], 'lesson 2.MP4')

    def test_invalid_urls_and_redirects_never_fetch_arbitrary_hosts(self):
        with patch.object(online, '_fetch') as fetch:
            for url in ['', None, 'file:///C:/private', 'javascript:alert(1)', '//example.com/video.mp4',
                        'https://user:password@example.com/x.mp4', 'https://www.bilibili.com.evil/video/' + BV,
                        'https://www.bilibili.com/video/not-a-bv', 'https://example.com/watch?id=1']:
                with self.subTest(url=url):
                    self.assertEqual(self.request({'url': url})[0], 400)
            fetch.assert_not_called()
        redirects = online._BilibiliRedirects()
        for url in ['http://127.0.0.1/private', 'file:///C:/private', 'https://evil.example/', 'https://api.bilibili.com:8443/']:
            with self.assertRaises(ValueError):
                redirects.redirect_request(None, None, 302, '', {}, url)

    def test_errors_and_local_api_access(self):
        with patch.object(online, '_fetch', return_value=COURSE):
            self.assertEqual(self.request({'url': URL + '?p=99'})[0], 400)
        with patch.object(online, '_fetch', return_value={'code': -404}):
            status, data = self.request({'url': URL})
            self.assertEqual(status, 400)
            self.assertFalse(data['ok'])
        with patch.object(online, '_fetch', side_effect=urllib.error.URLError('offline')):
            self.assertEqual(self.request({'url': URL})[0], 502)
        for doc in [None, [], {'code': 0, 'data': {'pages': ['invalid']}}]:
            with patch.object(online, '_fetch', return_value=doc):
                self.assertEqual(self.request({'url': URL})[0], 400)
        with patch.object(online, '_fetch') as fetch:
            self.assertEqual(self.request({'url': URL}, {'Origin': 'https://evil.example'})[0], 403)
            self.assertEqual(self.request({'url': URL}, {'Sec-Fetch-Site': 'cross-site'})[0], 403)
            self.assertEqual(self.request([])[0], 400)
            self.assertEqual(self.request({'url': 'x' * 9000})[0], 400)
            fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
