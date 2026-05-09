"""Pure helpers for fanqienovel.com discovery/snapshot scripts.

Site notes:
- Pages are server-rendered React with ``window.__INITIAL_STATE__ = {...}``
  embedded inline. The state JSON is JS-flavoured (contains ``undefined``)
  so we strip those before parsing.
- ``/rank?gender=N&category_id=K`` returns up to 10 books per category as
  ``state.rank.book_list``. Each entry already carries enough metadata to
  populate a candidate row (id, name, author, abstract, wordNumber,
  read_count, last-chapter info, thumb, etc.).
- ``/page/<bookId>`` is the full detail page with everything in
  ``state.page`` — what snapshot needs.
- Book ids are 18–19 digit numbers (Snowflake-style); we store them as
  strings throughout so they don't lose precision in the JSON pipeline.
- ``creationStatus``: ``1`` = ongoing, ``0`` = completed. ``status`` is
  always ``1`` and uninformative; we ignore it.
"""

import json
import re
import urllib.parse
from datetime import datetime, timezone

# Rank category IDs harvested from /rank's INITIAL_STATE.rank.rankCategoryTypeList.
# Used by discover to enumerate listing pages. (gender, category_id, name).
RANK_CATEGORIES = [
    (1, '1141', '西方奇幻'),
    (1, '1140', '东方仙侠'),
    (1, '8',    '科幻末世'),
    (1, '261',  '都市日常'),
    (1, '124',  '都市修真'),
    (1, '1014', '都市高武'),
    (1, '273',  '历史古代'),
    (1, '27',   '战神赘婿'),
    (1, '263',  '都市种田'),
    (1, '258',  '传统玄幻'),
    (1, '272',  '历史脑洞'),
    (1, '539',  '悬疑脑洞'),
    (1, '262',  '都市脑洞'),
    (1, '257',  '玄幻脑洞'),
    (1, '751',  '悬疑灵异'),
    (1, '504',  '抗战谍战'),
    (1, '746',  '游戏体育'),
    (1, '718',  '动漫衍生'),
    (1, '1016', '男频衍生'),
    (2, '1139', '古风世情'),
    (2, '8',    '科幻末世'),
    (2, '746',  '游戏体育'),
    (2, '1015', '女频衍生'),
    (2, '248',  '玄幻言情'),
    (2, '23',   '种田'),
    (2, '79',   '年代'),
    (2, '267',  '现言脑洞'),
    (2, '246',  '宫斗宅斗'),
    (2, '539',  '悬疑脑洞'),
    (2, '253',  '古言脑洞'),
    (2, '24',   '快穿'),
    (2, '749',  '青春甜宠'),
    (2, '745',  '星光璀璨'),
    (2, '747',  '女频悬疑'),
    (2, '750',  '职场婚恋'),
    (2, '748',  '豪门总裁'),
    (2, '1017', '民国言情'),
]
RANK_URL = 'https://fanqienovel.com/rank'
HOME_URL = 'https://fanqienovel.com/'
PAGE_URL = 'https://fanqienovel.com/page'

_UNDEF_RE = re.compile(r'(?<=[:\[,])\s*undefined\s*(?=[,\]\}])')
_INITIAL_STATE_MARKER = 'window.__INITIAL_STATE__'


def extract_initial_state(html):
    """Pull the ``window.__INITIAL_STATE__`` JSON object out of an HTML page.

    Returns the parsed dict. Raises ValueError if the marker is missing or
    the surrounding JS can't be balanced. Handles ``undefined`` literals
    that JSON.loads otherwise rejects.
    """
    i = html.find(_INITIAL_STATE_MARKER)
    if i < 0:
        raise ValueError('window.__INITIAL_STATE__ marker not found')
    try:
        j = html.index('=', i) + 1
    except ValueError as e:
        raise ValueError('no = after __INITIAL_STATE__ marker') from e
    while j < len(html) and html[j] in ' \t\n':
        j += 1
    if j >= len(html) or html[j] != '{':
        raise ValueError('expected `{` after __INITIAL_STATE__ =')
    # Balanced-brace scan that respects strings.
    depth = 0
    in_str = False
    esc = False
    end = None
    for k, c in enumerate(html[j:], j):
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                end = k + 1
                break
    if end is None:
        raise ValueError('unterminated __INITIAL_STATE__ object')
    raw = _UNDEF_RE.sub(' null', html[j:end])
    return json.loads(raw)


def parse_rank_book_list(html):
    """Return list of dicts harvested from a rank page's
    ``state.rank.book_list``. Each dict carries the raw fields jjwxc-style
    (camelCase). Caller normalises into snapshot rows separately."""
    state = extract_initial_state(html)
    bl = state.get('rank', {}).get('book_list') or []
    return list(bl)


def parse_home_lists(html):
    """Return a dict of named book lists from the homepage SSR state.

    Fanqie's homepage embeds several editorial / activity surfaces in
    ``state.home``: ``updateList`` (recent chapter publishes, 20 entries
    incl. chapter title and updateTime), ``boyList`` / ``girlList`` /
    ``editorList`` / ``weekList`` (editorial picks, 6–9 entries each).

    Each value list contains dicts with ``bookId``-bearing entries; we
    keep only those (filtering out the announcement/notice entries which
    don't have books).
    """
    state = extract_initial_state(html)
    home = state.get('home') or {}
    out = {}
    for key in ('updateList', 'boyList', 'girlList', 'editorList', 'weekList'):
        lst = home.get(key)
        if not isinstance(lst, list):
            continue
        kept = [e for e in lst if isinstance(e, dict) and e.get('bookId')]
        if kept:
            out[key] = kept
    return out


def _to_int(v):
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str) and v.strip():
        try:
            return int(v)
        except ValueError:
            return None
    return None


def _normalize_status(creation_status):
    """Fanqie's ``creationStatus``: 1 = ongoing, 0 = completed.

    Anything else maps to None so callers don't false-bucket weird values.
    """
    cs = _to_int(creation_status)
    if cs == 1:
        return 'ongoing'
    if cs == 0:
        return 'completed'
    return None


def _parse_category_v2(raw):
    """``categoryV2`` is a JSON array embedded as a string field. Returns the
    parsed list, or [] if absent/empty/malformed."""
    if not raw:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            v = json.loads(s)
        except (json.JSONDecodeError, ValueError):
            return []
        return v if isinstance(v, list) else []
    return []


def parse_book_detail(html):
    """Return a normalised dict for one novel from its /page/<bookId> HTML.

    Output schema (schema_version=1) — every field that's plausibly useful
    later for ML or dashboard, no aspirationally-massive lists (itemIds,
    chapterListWithVolume) so each row stays bounded.
    """
    state = extract_initial_state(html)
    page = state.get('page') or {}
    return {
        'schema_version': 1,
        'book_id': page.get('bookId') or None,
        'media_id': page.get('mediaId') or None,
        'book_name': page.get('bookName') or None,
        'author': page.get('author') or page.get('authorName') or None,
        'author_id': page.get('authorId') or page.get('creatorId') or None,
        'category': page.get('category') or None,
        'category_v2': _parse_category_v2(page.get('categoryV2')),
        'complete_category': page.get('completeCategory') or None,
        'abstract': page.get('abstract') or None,
        'word_number': _to_int(page.get('wordNumber')),
        'read_count': _to_int(page.get('readCount')),
        'creation_status': _to_int(page.get('creationStatus')),
        'status': _normalize_status(page.get('creationStatus')),
        'last_publish_time': _to_int(page.get('lastPublishTime')),
        'last_chapter_id': page.get('lastChapterItemId') or None,
        'last_chapter_title': page.get('lastChapterTitle') or None,
        'chapter_total': _to_int(page.get('chapterTotal')) or 0,
        'thumb_url': page.get('thumbUrl') or page.get('thumbUri') or None,
        'source_uri': page.get('sourceUri') or None,
    }


def normalize_rank_entry(entry):
    """Convert a /rank book_list entry into the snapshot schema.

    Rank entries are partial — read_count is on the rank, but readCount on
    the entry itself is often "0". We fall back to ``read_count`` (string)
    when present, otherwise to ``readCount``.
    """
    read_count = _to_int(entry.get('read_count'))
    if read_count is None:
        read_count = _to_int(entry.get('readCount'))
    return {
        'schema_version': 1,
        'book_id': entry.get('bookId') or None,
        'media_id': None,  # not in rank entries
        'book_name': entry.get('bookName') or None,
        'author': entry.get('author') or None,
        'author_id': entry.get('uid') or None,
        'category': entry.get('category') or None,
        'category_v2': _parse_category_v2(entry.get('categoryV2')),
        'complete_category': None,
        'abstract': entry.get('abstract') or None,
        'word_number': _to_int(entry.get('wordNumber')),
        'read_count': read_count,
        'creation_status': _to_int(entry.get('creationStatus')),
        'status': _normalize_status(entry.get('creationStatus')),
        'last_publish_time': _to_int(entry.get('lastChapterUpdateTime')),
        'last_chapter_id': entry.get('lastChapterItemId') or None,
        'last_chapter_title': entry.get('lastChapterTitle') or None,
        'chapter_total': 0,  # rank entry doesn't carry total
        'thumb_url': entry.get('thumbUri') or None,
        'source_uri': None,
    }


# --------- HTTP / URL helpers ---------

def build_rank_url(*, gender, category_id):
    qs = urllib.parse.urlencode({'gender': gender, 'category_id': category_id})
    return f'{RANK_URL}?{qs}'


def build_home_url():
    return HOME_URL


def build_page_url(book_id):
    return f'{PAGE_URL}/{book_id}'


# Reuse plumbing primitives from the jjwxc engine: lock file, JSONL I/O,
# UA + fetch_html. They have no jjwxc-specific behaviour and re-tested
# duplicating them would just bit-rot.
from scripts._jjwxc_engine import (  # noqa: E402
    fetch_html as _raw_fetch_html,
    append_jsonl,
    read_jsonl,
    now_iso,
    _Lock,
    filter_by_cycle,
    latest_snapshot_ts_by_id,
)


def fetch_html(url, **kw):
    """Fetch a Fanqie page as utf-8 (server's actual encoding).

    Defaults `min_body_bytes=2048` so the soft-block we observed (200 OK
    with 9-byte empty body when the IP is rate-limited) raises a clean
    rate-limit error instead of slipping through to the parser as a
    confusing "no INITIAL_STATE marker" failure. Real fanqie pages —
    even small "no books found" rank pages — are >40 KB.
    """
    kw.setdefault('encoding', 'utf-8')
    kw.setdefault('min_body_bytes', 2048)
    return _raw_fetch_html(url, **kw)


def load_candidate_book_ids(path):
    """Return set of book_ids previously written to candidates.jsonl."""
    out = set()
    for row in read_jsonl(path):
        bid = row.get('book_id')
        if isinstance(bid, str) and bid:
            out.add(bid)
    return out
