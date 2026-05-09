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
from datetime import datetime, timedelta, timezone

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)
BOOKBASE_URL = 'https://www.jjwxc.net/bookbase.php'
ONEBOOK_URL = 'https://www.jjwxc.net/onebook.php'

_NOVELID_RE = re.compile(r'onebook\.php\?novelid=(\d+)')
# Capture full opening tag of an itemprop element: tag name, full open-tag
# string, itemprop name. We need the full open-tag string because <meta> and
# <img> are self-closing and their value lives in the `content=`/`src=`
# attribute, not in tag content.
_ITEMPROP_OPEN_RE = re.compile(r'<(\w+)([^>]*\bitemprop="([^"]+)"[^>]*)>')
_TAG_RE = re.compile(r'<[^>]+>')
_WS_RE = re.compile(r'\s+')
_LASTUPDATE_RE = re.compile(r'最新更新:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
_H1_RE = re.compile(r'<h1[^>]*>([\s\S]*?)</h1>')
_TITLE_TAG_RE = re.compile(r'<title>\s*《([^》]+)》([^_]+?)\s*[_^]')
_TAG_BLOCK_RE = re.compile(
    r'内容标签[\s\S]{0,2000}?<div[^>]*>([\s\S]*?)</div>', re.MULTILINE
)
_AUTHORID_RE = re.compile(r'oneauthor\.php\?authorid=(\d+)')
_VOID_TAGS = {'meta', 'img', 'input', 'br', 'hr', 'link'}
_ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
# Per-chapter rows on the detail page. Each row carries:
#   - chapter_id (chapterid=N in the chapter URL)
#   - title text inside the <a itemprop="url">…</a>
#   - word_count from <td itemprop="wordCount">N</td>
#   - publish_date from the trailing <span>YYYY-MM-DD HH:MM:SS</span>
_CHAPTER_ROW_RE = re.compile(
    r'<tr[^>]*itemprop="chapter[^"]*"[^>]*>([\s\S]*?)</tr>'
)
_CHAPTER_LINK_RE = re.compile(
    r'<a[^>]*itemprop="url"[^>]*href="[^"]*chapterid=(\d+)[^"]*"[^>]*>([\s\S]*?)</a>'
)
_CHAPTER_WC_RE = re.compile(r'itemprop="wordCount"[^>]*>(\d+)<')
_CHAPTER_DATE_RE = re.compile(r'(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})')


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
        tag = m.group(1).lower()
        attrs_str = m.group(2)
        name = m.group(3)
        if tag in _VOID_TAGS:
            # Self-closing element: extract value from attributes.
            attrs = dict(_ATTR_RE.findall(attrs_str))
            raw = attrs.get('content') or attrs.get('src') or attrs.get('_src') or ''
            raw = raw.strip()
        else:
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

    author_id = None
    am = _AUTHORID_RE.search(html)
    if am:
        author_id = int(am.group(1))

    chapters = _parse_chapter_list(html)

    return {
        'schema_version': 2,
        'title': title,
        'author': author,
        'author_id': author_id,
        'genre': props.get('genre'),
        'word_count': total_wc,
        'chapter_count': chapter_count,
        'collects': _parse_int(props.get('collectedCount')),
        'reviews': _parse_int(props.get('reviewCount')),
        'score': _parse_int(props.get('scoreCount')),
        'status': status,
        'last_update': last_update,
        'date_modified': _normalize_date(props.get('dateModified')),
        'description': _normalize_description(props.get('description')),
        'series': _normalize_series(props.get('series')),
        'cover_url': props.get('image') or None,
        'nutrition_count': _parse_int(props.get('nutritionCount')) or 0,
        'tags': tags,
        'chapters': chapters,
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


def _normalize_date(s):
    """Strip jjwxc's '0000-00-00 00:00:00' placeholder so callers can rely
    on a real date or None — never a fake all-zero stamp."""
    if not s:
        return None
    s = s.strip()
    if not s or s == '0000-00-00 00:00:00':
        return None
    return s


def _normalize_description(s):
    """Description text is often newline-noisy and sometimes has trailing
    template separators ('————'). Collapse whitespace and strip flanking
    separators so the field is comparable across snapshots."""
    if not s:
        return None
    text = _collapse_ws(s)
    text = text.strip('—-')
    text = _collapse_ws(text)
    return text or None


def _normalize_series(s):
    """jjwxc renders '无从属系列' (= no series) literally — convert to None."""
    if not s:
        return None
    text = _collapse_ws(s)
    if not text or text in ('无从属系列', '-', '——', '无'):
        return None
    return text


def _parse_chapter_list(html):
    """Return list of {chapter_id, idx, title, word_count, published_at}.

    Per-chapter rows on the detail page carry id (in the chapter URL),
    title, word count (itemprop), and a publish-date string. We deliberately
    skip per-chapter VIP/click counts: VIP markers are inconsistent across
    layouts, and clicks are JS-lazy-loaded and absent from the static HTML.
    """
    out = []
    for idx, m in enumerate(_CHAPTER_ROW_RE.finditer(html), 1):
        body = m.group(1)
        link = _CHAPTER_LINK_RE.search(body)
        if not link:
            # Restricted-view rows have no link; record an indexed placeholder
            # so the per-chapter list length still reflects what jjwxc shows.
            out.append({
                'idx': idx,
                'chapter_id': None,
                'title': None,
                'word_count': None,
                'published_at': None,
            })
            continue
        chapter_id = int(link.group(1))
        title = _collapse_ws(_strip_tags(link.group(2)))
        wc_m = _CHAPTER_WC_RE.search(body)
        word_count = int(wc_m.group(1)) if wc_m else None
        date_m = _CHAPTER_DATE_RE.search(body)
        published_at = date_m.group(1) if date_m else None
        out.append({
            'idx': idx,
            'chapter_id': chapter_id,
            'title': title,
            'word_count': word_count,
            'published_at': published_at,
        })
    return out


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

def fetch_html(url, *, timeout=15, retries=3, backoff_seconds=2.0, encoding='gb18030'):
    """GET `url`, decode bytes with the given encoding.

    Retries on transient failures only — connection resets, DNS, raw
    timeouts. **HTTP 4xx is treated as terminal:** retrying a 403/404
    just re-triggers any WAF on the other end (we learned this the hard
    way when Qidian's WAF kept us in a CLOSE-WAIT loop). 5xx is treated
    as transient.

    Encoding is per-site: jjwxc serves gb18030, fanqie serves utf-8. Pass
    ``encoding=None`` to detect from response Content-Type charset (falls
    back to utf-8 if absent).
    """
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
                resolved = encoding
                if resolved is None:
                    ct = resp.headers.get('Content-Type', '')
                    m = re.search(r'charset=([^\s;]+)', ct, re.I)
                    resolved = m.group(1) if m else 'utf-8'
            return raw.decode(resolved, errors='replace')
        except urllib.error.HTTPError as e:
            # Don't retry client-side errors — they're terminal for this URL.
            if 400 <= e.code < 500:
                raise RuntimeError(f'fetch {url}: HTTP {e.code}') from e
            last_err = e
            if attempt + 1 < retries:
                time.sleep(backoff_seconds * (attempt + 1))
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


def latest_snapshot_ts_by_id(snapshot_path, id_field):
    """Return {id: datetime_of_latest_snapshot_for_that_id} from a snapshots.jsonl.

    Used by snapshot scripts' ``--cycle-hours`` filter to skip ids whose most
    recent snapshot is younger than the cycle threshold. Reads linearly; fine
    up to a few hundred MB. Returns aware UTC datetimes.
    """
    out = {}
    for row in read_jsonl(snapshot_path):
        nid = row.get(id_field)
        ts_str = row.get('ts')
        if nid is None or not isinstance(ts_str, str):
            continue
        try:
            t = datetime.strptime(ts_str, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if nid not in out or t > out[nid]:
            out[nid] = t
    return out


def filter_by_cycle(ids, snapshot_path, id_field, cycle_hours):
    """Reorder + filter `ids` for "cycle-aware" snapshot iteration.

    With cycle_hours=0 (or negative): pass through unchanged — caller sees
    the full candidate list in registry order.
    With cycle_hours>0: drop any id whose latest snapshot is younger than
    the threshold, then sort the rest so never-snapshotted ids come first
    and remaining ids are oldest-snapshot-first. This gives a stable
    "snapshot the most-overdue books first" iteration that pairs with
    --limit to bound each cron tick's request budget.
    """
    if cycle_hours <= 0:
        return list(ids)
    cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=cycle_hours)
    last = latest_snapshot_ts_by_id(snapshot_path, id_field)
    bucketed = []  # [(sort_key, id)] where sort_key prioritises never-seen first.
    for nid in ids:
        t = last.get(nid)
        if t is None:
            bucketed.append(((0, datetime.min.replace(tzinfo=timezone.utc)), nid))
        elif t < cutoff:
            bucketed.append(((1, t), nid))
        # else: too recent, drop
    bucketed.sort(key=lambda x: x[0])
    return [nid for _, nid in bucketed]


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
