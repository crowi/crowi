import * as codemirror from 'codemirror';

class MarkdownListHelper {

  constructor() {
    // https://github.com/codemirror/CodeMirror/blob/c7853a989c77bb9f520c9c530cbe1497856e96fc/addon/edit/continuelist.js#L14
    // https://regex101.com/r/7BN2fR/5
    this.indentAndMarkRE = /^(\s*)(>[> ]*|[*+-] \[[x ]\]\s|[*+-]\s|(\d+)([.)]))(\s*)/;
    this.indentAndMarkOnlyRE = /^(\s*)(>[> ]*|[*+-] \[[x ]\]|[*+-]|(\d+)[.)])(\s*)$/;

    this.newlineAndIndentContinueMarkdownList = this.newlineAndIndentContinueMarkdownList.bind(this);
    this.pasteText = this.pasteText.bind(this);

    this.getBol = this.getBol.bind(this);
    this.getEol = this.getEol.bind(this);
    this.getStrFromBol = this.getStrFromBol.bind(this);
    this.getStrToEol = this.getStrToEol.bind(this);
  }

  /**
   * wrap codemirror.commands.newlineAndIndentContinueMarkdownList
   * @param {any} editor An editor instance of CodeMirror
   */
  newlineAndIndentContinueMarkdownList(editor) {
    // get strings from current position to EOL(end of line) before break the line
    const strToEol = this.getStrToEol(editor);

    if (this.indentAndMarkRE.test(strToEol)) {
      codemirror.commands.newlineAndIndent(editor);
      // replace the line with strToEol (abort auto indent)
      editor.getDoc().replaceRange(strToEol, this.getBol(editor), this.getEol(editor));
    }
    else {
      codemirror.commands.newlineAndIndentContinueMarkdownList(editor);
    }
  }

  /**
   * paste text
   * @param {any} editor An editor instance of CodeMirror
   * @param {any} event
   * @param {string} text
   */
  pasteText(editor, event, text) {
    // get strings from BOL(beginning of line) to current position
    const strFromBol = this.getStrFromBol(editor);

    const matched = strFromBol.match(this.indentAndMarkRE);
    // when match indentAndMarkOnlyRE
    // (this means the current position is the beginning of the list item)
    if (this.indentAndMarkOnlyRE.test(strFromBol)) {
      const adjusted = this.adjustPastedData(strFromBol, text);

      // replace
      if (adjusted != null) {
        event.preventDefault();
        editor.getDoc().replaceRange(adjusted, this.getBol(editor), editor.getCursor());
      }
    }
  }

  /**
   * return adjusted pasted data by indentAndMark
   *
   * @param {string} indentAndMark
   * @param {string} text
   * @returns adjusted pasted data
   *      returns null when adjustment is not necessary
   */
  adjustPastedData(indentAndMark, text) {
    let adjusted = null;

    // list data (starts with indent and mark)
    if (text.match(this.indentAndMarkRE)) {
      const indent = indentAndMark.match(this.indentAndMarkRE)[1];

      // splice to an array of line
      const lines = text.match(/[^\r\n]+/g);
      // indent
      const replacedLines = lines.map((line) => {
        return indent + line;
      })

      adjusted = replacedLines.join('\n');
    }
    // listful data
    else if (this.isListfulData(text)) {
      // do nothing (return null)
    }
    // not listful data
    else {
      // append `indentAndMark` at the beginning of all lines (except the first line)
      const replacedText = text.replace(/(\r\n|\r|\n)/g, "$1" + indentAndMark);
      // append `indentAndMark` to the first line
      adjusted = indentAndMark + replacedText;
    }

    return adjusted;
  }

  /**
   * evaluate whether `text` is list like data or not
   * @param {string} text
   */
  isListfulData(text) {
    // return false if includes at least one blank line
    // see https://stackoverflow.com/a/16369725
    if (text.match(/^\s*[\r\n]/m) != null) {
      return false;
    }

    const lines = text.match(/[^\r\n]+/g);
    // count lines that starts with indent and mark
    let isListful = false;
    let count = 0;
    lines.forEach((line) => {
      if (line.match(this.indentAndMarkRE)) {
        count++;
      }
      // ensure to be true if it is 50% or more
      if (count >= lines.length / 2) {
        isListful = true;
        return;
      }
    });

    return isListful;
  }

  /**
   * return the postion of the BOL(beginning of line)
   */
  getBol(editor) {
    const curPos = editor.getCursor();
    return { line: curPos.line, ch: 0 };
  }

  /**
   * return the postion of the EOL(end of line)
   */
  getEol(editor) {
    const curPos = editor.getCursor();
    const lineLength = editor.getDoc().getLine(curPos.line).length;
    return { line: curPos.line, ch: lineLength };
  }

  /**
   * return strings from BOL(beginning of line) to current position
   */
  getStrFromBol(editor) {
    const curPos = editor.getCursor();
    return editor.getDoc().getRange(this.getBol(editor), curPos);
  }

  /**
   * return strings from current position to EOL(end of line)
   */
  getStrToEol(editor) {
    const curPos = editor.getCursor();
    return editor.getDoc().getRange(curPos, this.getEol(editor));
  }
}

// singleton pattern
const instance = new MarkdownListHelper();
Object.freeze(instance);
export default instance;
