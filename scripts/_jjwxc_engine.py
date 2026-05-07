"""Pure helpers for jjwxc.net discovery/snapshot scripts.

Site notes:
- HTML pages are gb18030-encoded.
- Detail page (onebook.php?novelid=N) renders Schema.org itemprop tags
  server-side for collects/score/reviews/word_count/genre/title/author/status.
- Listing page (bookbase.php) gives novel_id + cover, but NOT collects/wc inline,
  so band-filtering needs a detail fetch per id.
- Sort param sortType: 1=last update, 2=score, 3=newest published,
  4=collects, 5=word count.
- isfinish: 0=any, 1=ongoing, 2=completed.
"""

import gzip
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)
BOOKBASE_URL = 'https://www.jjwxc.net/bookbase.php'
ONEBOOK_URL = 'https://www.jjwxc.net/onebook.php'

_NOVELID_RE = re.compile(r'onebook\.php\?novelid=(\d+)')
# Capture the element's tag name + itemprop name + the content up to the next
# tag. Most itemprops wrap a leaf text like <span itemprop="x">42</span>;
# nested cases (<span itemprop="name"><span itemprop="articleSection">…</span>)
# yield empty plain content, in which case we fall back to a wider window with
# tags stripped so wrappers like <font color=red>完结</font> still resolve.
_ITEMPROP_OPEN_RE = re.compile(r'<(\w+)[^>]*\bitemprop="([^"]+)"[^>]*>')
_TAG_RE = re.compile(r'<[^>]+>')
_WS_RE = re.compile(r'\s+')
_LASTUPDATE_RE = re.compile(r'最新更新:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
_H1_RE = re.compile(r'<h1[^>]*>([\s\S]*?)</h1>')
_TITLE_TAG_RE = re.compile(r'<title>\s*《([^》]+)》([^_]+?)\s*[_^]')
_TAG_BLOCK_RE = re.compile(
    r'内容标签[\s\S]{0,2000}?<div[^>]*>([\s\S]*?)</div>', re.MULTILINE
)


def _strip_tags(s):
    return _TAG_RE.sub('', s)


def _extract_itemprop_value(html, start, tag):
    """Return the text content of the element opened at `start` in `html`.

    Walks forward respecting nesting of `<tag>` so we don't stop at the close
    tag of an inner element. Strips inner tags from the captured slice.
    """
    open_re = re.compile(r'<' + tag + r'\b[^>]*>')
    close_re = re.compile(r'</' + tag + r'>')
    depth = 1
    pos = start
    end = len(html)
    while depth > 0 and pos < end:
        next_close = close_re.search(html, pos)
        if not next_close:
            return _collapse_ws(_strip_tags(html[start:]))
        next_open = open_re.search(html, pos, next_close.start())
        if next_open:
            depth += 1
            pos = next_open.end()
        else:
            depth -= 1
            if depth == 0:
                return _collapse_ws(_strip_tags(html[start:next_close.start()]))
            pos = next_close.end()
    return _collapse_ws(_strip_tags(html[start:pos]))


def _collapse_ws(s):
    return _WS_RE.sub(' ', s).strip()


def _parse_int(s):
    if s is None:
        return None
    s = s.replace(',', '').replace('，', '').strip()
    m = re.match(r'-?\d+', s)
    return int(m.group(0)) if m else None


def parse_bookbase_listing(html):
    """Return list of unique novel_ids in document order from a bookbase HTML page."""
    seen = set()
    out = []
    for m in _NOVELID_RE.finditer(html):
        nid = int(m.group(1))
        if nid in seen:
            continue
        seen.add(nid)
        out.append(nid)
    return out


def parse_onebook_html(html):
    """Extract a novel's metadata from its onebook.php detail page.

    Returns a dict with: title, author, genre, word_count (int),
    chapter_count, collects, reviews, score, status ('ongoing'|'completed'|None),
    last_update (ISO string or None), tags (list[str]).
    """
    props = {}  # name -> first textual value
    word_counts = []  # raw per-chunk wordCount values, in document order
    for m in _ITEMPROP_OPEN_RE.finditer(html):
        tag = m.group(1)
        name = m.group(2)
        raw = _extract_itemprop_value(html, m.end(), tag)
        if name == 'wordCount':
            word_counts.append(raw)
        elif name not in props:
            props[name] = raw

    # word_count values come as "65845字" or just "1529"; first occurrence is the
    # book-level total, subsequent are per-chapter.
    total_wc = None
    chapter_count = 0
    if word_counts:
        total_wc = _parse_int(word_counts[0])
        chapter_count = max(0, len(word_counts) - 1)

    status = None
    raw_status = props.get('updataStatus')
    if raw_status:
        if '完结' in raw_status:
            status = 'completed'
        elif '连载' in raw_status:
            status = 'ongoing'
        else:
            status = raw_status

    last_update = None
    m = _LASTUPDATE_RE.search(html)
    if m:
        v = m.group(1)
        # jjwxc emits 0000-00-00 00:00:00 when no chapter has been published.
        if v != '0000-00-00 00:00:00':
            last_update = v

    tags = _parse_content_tags(html)

    # Some novel pages omit itemprop="articleSection"/"author" (restricted-view
    # variants). Fall back to <h1> for title and <title> for both.
    title = props.get('articleSection') or _fallback_title(html)
    author = props.get('author') or _fallback_author(html)

    return {
        'title': title,
        'author': author,
        'genre': props.get('genre'),
        'word_count': total_wc,
        'chapter_count': chapter_count,
        'collects': _parse_int(props.get('collectedCount')),
        'reviews': _parse_int(props.get('reviewCount')),
        'score': _parse_int(props.get('scoreCount')),
        'status': status,
        'last_update': last_update,
        'tags': tags,
    }


def _fallback_title(html):
    """Title from <h1> (preferred) or <title>《X》... (last resort)."""
    m = _H1_RE.search(html)
    if m:
        text = _collapse_ws(_strip_tags(m.group(1)))
        if text:
            return text
    m = _TITLE_TAG_RE.search(html)
    if m:
        return m.group(1).strip()
    return None


def _fallback_author(html):
    """Author from <title>《X》Y... pattern; jjwxc page titles always include it."""
    m = _TITLE_TAG_RE.search(html)
    if m:
        return m.group(2).strip()
    return None


def _parse_content_tags(html):
    """Extract content tags (内容标签) as a clean list of strings.

    Tags appear inside an inline list; we strip HTML, split on whitespace
    (including &nbsp;) and filter out empty/punctuation entries.
    """
    i = html.find('内容标签')
    if i < 0:
        return []
    chunk = html[i:i + 2000]
    end = chunk.find('一句话简介')
    if end > 0:
        chunk = chunk[:end]
    text = _strip_tags(chunk)
    # &nbsp; (and its decoded form \xa0) act as tag separators on jjwxc; turn
    # them into plain spaces so the splitter below sees one boundary per gap.
    text = text.replace('&nbsp;', ' ').replace('\xa0', ' ').replace('内容标签：', '')
    out = []
    for raw in re.split(r'\s+', text):
        t = raw.strip()
        if not t or t in {'：', ':'}:
            continue
        out.append(t)
    return out


# --------- HTTP / IO helpers ---------

def fetch_html(url, *, timeout=30, retries=3, backoff_seconds=2.0):
    """GET `url`, decode as gb18030, with retries on transient failures."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    'User-Agent': USER_AGENT,
                    'Accept-Encoding': 'gzip, deflate',
                    'Accept': 'text/html,application/xhtml+xml',
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get('Content-Encoding') == 'gzip':
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            return raw.decode('gb18030', errors='replace')
        except (urllib.error.URLError, TimeoutError, ConnectionResetError) as e:
            last_err = e
            if attempt + 1 < retries:
                time.sleep(backoff_seconds * (attempt + 1))
    raise RuntimeError(f'fetch failed for {url}: {last_err}')


def build_bookbase_url(*, sort_type=3, page=1, isfinish=1):
    qs = urllib.parse.urlencode({
        'bs': 1,
        'sortType': sort_type,
        'page': page,
        'isfinish': isfinish,
        'collectiontypes': '',
        'searchkeywords': '',
        'm_p': 0,
    })
    return f'{BOOKBASE_URL}?{qs}'


def build_onebook_url(novel_id):
    return f'{ONEBOOK_URL}?novelid={int(novel_id)}'


# --------- JSONL I/O ---------

def now_iso():
    return datetime.now(tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n')


def read_jsonl(path):
    """Yield each row in the JSONL file (or yield nothing if file missing)."""
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def load_candidate_ids(path):
    """Return set of novel_ids previously written to candidates.jsonl."""
    out = set()
    for row in read_jsonl(path):
        nid = row.get('novel_id')
        if isinstance(nid, int):
            out.add(nid)
    return out


# --------- Cron / locking helpers ---------

class _Lock:
    """Simple cross-platform exclusive file lock for cron safety.

    Acquires fcntl.flock(LOCK_EX | LOCK_NB) and writes the holding pid into
    the file. Raises RuntimeError if another process holds the lock — never
    blocks. The lock is released on context exit even if the process crashes
    (kernel releases fcntl locks on process exit).
    """

    def __init__(self, path):
        self.path = path
        self._fh = None

    def __enter__(self):
        import fcntl
        os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
        self._fh = open(self.path, 'a+')
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            self._fh.seek(0)
            holder = self._fh.read().strip() or '<unknown>'
            self._fh.close()
            self._fh = None
            raise RuntimeError(f'lock held by pid {holder} ({self.path})')
        # Record pid so a stuck process can be diagnosed by reading the file.
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(f'{os.getpid()}\n')
        self._fh.flush()
        return self

    def __exit__(self, *exc):
        if self._fh is not None:
            try:
                self._fh.close()  # releases flock as a side effect
            finally:
                self._fh = None
