"""Pure helpers for m.qidian.com discovery/snapshot scripts.

Site notes:
- The desktop www.qidian.com is gated by a Tencent "Lego Server" WAF that
  serves a JS challenge (probe.js). We bypass it by using the **mobile**
  site m.qidian.com, which currently has no challenge.
- Pages are Vite-SSR React with their state in
  ``<script id="vite-plugin-ssr_pageContext">{ ... }</script>``. That JSON
  IS the API response — we parse it directly, no further calls needed.
- /rank/yuepiao paginates monthly-ticket rank with 20 records per page,
  total 1000 books. Used as the discovery surface (covers the active
  catalogue across categories).
- /book/<bookId> is the detail page; ``pageData.bookInfo`` carries the
  full novel state.
- Book ids on Qidian fit in int64 (10-digit decimals like ``1010868264``)
  but we keep them as strings for consistency with fanqie.
- Encoding: utf-8.
"""

import json
import re
import urllib.parse

USER_AGENT_MOBILE = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) '
    'AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
)
RANK_YUEPIAO_URL = 'https://m.qidian.com/rank/yuepiao'
RANK_NEWBOOK_URL = 'https://m.qidian.com/rank/newbook'
BOOK_URL = 'https://m.qidian.com/book'

# /rank/yuepiao paginates client-side via XHR — the URL ?page=N parameter is
# silently ignored by the SSR. Each `catid<N>` slug gives a separate
# 20-record SSR list (with total=100 per catid, but no way to reach pages
# 2+ via URL). Walking every catid is our discovery surface.
#
# Catids are the channel slugs harvested from the /rank/yuepiao homepage
# HTML at scaffold time. ``-1`` is the special "all" slug (which has
# total=1000 across channels but the same 20-row first page). The list
# may need to be re-harvested if Qidian adds a new channel — see
# `harvest_catids` for an automated probe.
RANK_CATIDS = [
    '-1',     # all channels, top 20 by month
    '1',      # 玄幻 (xuanhuan)
    '2',      # 奇幻 (qihuan)
    '4',      # 武侠 (wuxia)
    '5',      # 仙侠 (xianxia, classic)
    '6',      # 都市 (urban)
    '7',      # 现实 (realism)
    '8',      # 军事 (military)
    '9',      # 历史 (history)
    '10',     # 游戏 (gaming)
    '12',     # 轻小说 (light novel)
    '15',     # 体育 (sports)
    '21',     # 玄幻 (alt category)
    '22',     # 仙侠 (alt category)
    '20109',  # 诸天无限 (multiverse)
]

_SSR_RE = re.compile(
    r'<script[^>]*id="vite-plugin-ssr_pageContext"[^>]*>([\s\S]*?)</script>'
)


def extract_pagecontext(html):
    """Return the parsed Vite SSR pageContext JSON.

    Raises ValueError when the script tag is absent — callers treat that
    as a hard failure (page layout changed or WAF inserted itself).
    """
    m = _SSR_RE.search(html)
    if not m:
        raise ValueError('vite-plugin-ssr_pageContext script not found')
    return json.loads(m.group(1))


def _to_int(v):
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str) and v.strip():
        try:
            return int(v)
        except ValueError:
            return None
    return None


def _normalize_status(action_status):
    """Qidian's ``actionStatus`` is a free-form string. Map the canonical
    completed / ongoing markers to our universal status enum; anything
    else stays None so we don't false-bucket weirder states."""
    if not action_status:
        return None
    s = str(action_status)
    if '完本' in s or '完结' in s:
        return 'completed'
    if '连载' in s:
        return 'ongoing'
    return None


def parse_rank_records(html):
    """Return ``(records, page_meta)`` from any /rank/* page (yuepiao,
    newbook, …) that uses the SSR ``pageData.records`` shape.

    records: list of raw dicts as the rank API surfaces them
        (each has ``bid``, ``bName``, ``bAuth``, ``cat``, ``cnt``, …).
    page_meta: dict with total/pageNum/isLast.
    """
    ctx = extract_pagecontext(html)
    pd = ctx.get('pageContext', {}).get('pageProps', {}).get('pageData', {})
    return list(pd.get('records') or []), {
        'total': pd.get('total'),
        'pageNum': pd.get('pageNum'),
        'isLast': pd.get('isLast'),
    }


# Back-compat alias kept so old callers (and tests) don't break.
parse_yuepiao_records = parse_rank_records


def parse_book_detail(html):
    """Return a normalised dict for one novel from its /book/<bookId> HTML.

    Output schema (schema_version=1) — every field that's plausibly useful
    later for ML or growth ranking, no aspirationally-massive lists, all
    numbers coerced to int (never strings, never None+empty-string mix).
    """
    ctx = extract_pagecontext(html)
    pd = ctx.get('pageContext', {}).get('pageProps', {}).get('pageData', {})
    bi = pd.get('bookInfo') or {}
    book_id = bi.get('bookId')
    if isinstance(book_id, int):
        book_id = str(book_id)
    return {
        'schema_version': 1,
        'book_id': book_id or None,
        'cbid': bi.get('cbid') or None,
        'book_name': bi.get('bookName') or None,
        'author_name': bi.get('authorName') or None,
        'author_id': _to_int(bi.get('authorId')),
        'c_author_id': bi.get('cAuthorId') or None,
        'chan_id': _to_int(bi.get('chanId')),
        'chan_name': bi.get('chanName') or None,
        'chan_alias': bi.get('chanAlias') or None,
        'sub_cate_id': _to_int(bi.get('subCateId')),
        'sub_cate_name': bi.get('subCateName') or None,
        'action_status': bi.get('actionStatus') or None,
        'book_status': bi.get('bookStatus') or None,
        'status': _normalize_status(bi.get('actionStatus')),
        'sign_status': bi.get('signStatus') or None,
        'is_sign': _to_int(bi.get('isSign')),
        'is_vip': _to_int(bi.get('isVip')),
        'words_cnt': _to_int(bi.get('wordsCnt')),
        'show_words_cnt': bi.get('showWordsCnt') or None,
        'recom_all': _to_int(bi.get('recomAll')),
        'recom_week': _to_int(bi.get('recomWeek')),
        'collect': _to_int(bi.get('collect')),
        'month_ticket': _to_int(bi.get('monthTicket')),
        'click_total': _to_int(bi.get('clickTotal')),
        'vip_click_all': _to_int(bi.get('vipClickAll')),
        'vip_click_week': _to_int(bi.get('vipClickWeek')),
        'desc': bi.get('desc') or None,
        'upd_chapter_id': _to_int(bi.get('updChapterId')),
        'upd_chapter_name': bi.get('updChapterName') or None,
        'upd_time': bi.get('updTime') or None,
        'upd_times': _to_int(bi.get('updTimes')),
        'join_time': _to_int(bi.get('joinTime')),
    }


def normalize_yuepiao_record(entry):
    """Convert a /rank/yuepiao record into the discover-time view of a
    book. Rank entries carry a small subset of fields; we keep what's there
    and let the snapshot phase pull the canonical detail.
    """
    return {
        'book_id': str(entry['bid']) if entry.get('bid') is not None else None,
        'rank_num': _to_int(entry.get('rankNum')),
        'cat_id': _to_int(entry.get('catId')),
        'cat': entry.get('cat') or None,
        'sub_cat_id': _to_int(entry.get('subCatId')),
        'sub_cat': entry.get('subCat') or None,
        'book_name': entry.get('bName') or None,
        'author_name': entry.get('bAuth') or None,
        'show_words_cnt': entry.get('cnt') or None,
        'rank_cnt': entry.get('rankCnt') or None,
        'desc': entry.get('desc') or None,
    }


# --------- HTTP / URL helpers ---------

def build_yuepiao_url(*, catid=None, page=1):
    """Build a /rank/yuepiao URL.

    With catid: ``/rank/yuepiao/catid<X>/`` — the per-channel slug. This is
    the only working pagination axis on Qidian mobile; the ``?page=`` param
    is silently ignored by the SSR.
    Without catid: the default homepage which also returns 20 rows.
    """
    if catid is not None:
        return f'{RANK_YUEPIAO_URL}/catid{catid}/'
    return f'{RANK_YUEPIAO_URL}?page={page}' if page > 1 else RANK_YUEPIAO_URL


def build_newbook_url(*, catid=None):
    """Build a /rank/newbook URL.

    /rank/newbook is the dedicated **newest-book** ranking on m.qidian.com —
    the only path to brand-new (chapter 1–~50) novels through the SSR. Same
    catid-walk pattern as yuepiao: 20 records per fetch, total up to 600
    across channels.
    """
    if catid is not None:
        return f'{RANK_NEWBOOK_URL}/catid{catid}/'
    return RANK_NEWBOOK_URL


def build_book_url(book_id):
    return f'{BOOK_URL}/{book_id}'


# Reuse plumbing from the jjwxc engine (lock, JSONL, fetch_html, now_iso).
# fetch_html_qidian wraps the shared helper to (a) pin utf-8 and
# (b) override the default UA with a mobile one — Qidian's WAF gates the
# desktop UA.
from scripts._jjwxc_engine import (  # noqa: E402
    append_jsonl,
    read_jsonl,
    now_iso,
    _Lock,
    filter_by_cycle,
    latest_snapshot_ts_by_id,
)
import gzip
import io
import time
import urllib.error
import urllib.request


def fetch_html(url, **kw):
    """Fetch m.qidian.com pages with the mobile UA pool + persistent cookie
    jar that the site's WAF expects to see.

    Delegates to the shared engine's fetch_html with site-pinned defaults:
      encoding=utf-8, min_body_bytes=2048 (treat tiny 200s as 429),
      ua_pool=_MOBILE_UA_POOL, jar_key='qidian',
      referer=https://m.qidian.com/ for /book/* (real-browser nav signal).
    """
    from scripts._jjwxc_engine import fetch_html as _raw, _MOBILE_UA_POOL
    kw.setdefault('encoding', 'utf-8')
    kw.setdefault('min_body_bytes', 2048)
    kw.setdefault('ua_pool', _MOBILE_UA_POOL)
    kw.setdefault('jar_key', 'qidian')
    if '/book/' in url and 'referer' not in kw:
        kw['referer'] = 'https://m.qidian.com/'
    return _raw(url, **kw)


def load_candidate_book_ids(path):
    """Return set of book_ids previously written to candidates.jsonl."""
    out = set()
    for row in read_jsonl(path):
        bid = row.get('book_id')
        if isinstance(bid, str) and bid:
            out.add(bid)
    return out
