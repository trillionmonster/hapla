import { describe, it, expect } from 'vitest';
import { parseReviewPatch } from './gitWorkbenchDiff';

describe('reviewing paged Git patches', () => {
    it('keeps old/new line numbers across separate hunks, files, and no-newline markers', () => {
        const result = parseReviewPatch('diff --git a/a file.txt b/a file.txt\nindex 123..456 100644\n--- a/a file.txt\n+++ b/a file.txt\n@@ -8,2 +8,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n@@ -20 +30 @@\n-later\n+replacement\ndiff --git a/中文.txt b/中文.txt\nnew file mode 100644\n--- /dev/null\n+++ b/中文.txt\n@@ -0,0 +1 @@\n+新增\n');
        expect(result.added).toBe(3); expect(result.removed).toBe(2); expect(result.files).toBe(2);
        expect(result.lines.filter(line => line.kind === 'file').map(line => line.text)).toEqual(['a file.txt', '中文.txt']);
        expect(result.lines.filter(line => line.kind === 'add').map(line => line.newLine)).toEqual([9, 30, 1]);
        expect(result.lines.filter(line => line.kind === 'remove').map(line => line.oldLine)).toEqual([9, 20]);
        expect(result.lines.find(line => line.kind === 'context')).toMatchObject({ oldLine: 8, newLine: 8 });
    });
    it('keeps complete paths containing spaces and b/ when renaming or deleting', () => {
        const patch = 'diff --git a/old b/entry.txt b/new b/entry.txt\n--- a/old b/entry.txt\n+++ b/new b/entry.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/deleted b/file.txt b/deleted b/file.txt\n--- a/deleted b/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n';
        expect(parseReviewPatch(patch).lines.filter(line => line.kind === 'file').map(line => line.text)).toEqual(['new b/entry.txt', 'deleted b/file.txt']);
    });
    it('renders metadata-only/binary diffs and recomputes a split line when the next page arrives', () => {
        const first = 'diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+中文 first\n+part';
        expect(parseReviewPatch(first).lines.at(-1)?.text).toBe('part');
        const complete = parseReviewPatch(first + 'ial\n');
        expect(complete.lines.at(-1)?.text).toBe('partial'); expect(complete.added).toBe(2);
        expect(parseReviewPatch('diff --git a/image.png b/image.png\nGIT binary patch\nliteral 4\nabc\n').lines.some(line => line.text === 'GIT binary patch')).toBe(true);
    });
});
