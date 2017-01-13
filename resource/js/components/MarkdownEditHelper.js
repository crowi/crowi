import React from 'react';

class MardownEditHelper extends React.Component {
  constructor(props) {
    super(props);
  }

  componentDidMount() {
    this.enableEvent();
  }

  enableEvent() {
    this.props.editor.addEventListener('keydown', (e) => {
      if (e.metaKey === true) {
        switch (e.key) {
          case 'b':
            this.handleBold();
            break;
          case 'i':
            this.handleBold();
            break;
          case 'k':
            this.handleLink();
            break;
          // case 's':
          //   // TODO: save document or other action
          //   e.preventDefault();
          //   break;
          default:
            // nothing to do
        }
      }
    });
  }

  createButton(iconClass, handler, title, string) {
    const iconClassName = 'fa ' + iconClass;

    return (
      <span>
        <a className="btn" onClick={handler} data-toggle="tooltip" data-placement="top" title={title}>
          <i className={iconClassName} aria-hidden="true"></i>{string}
        </a>
      </span>
    );
  }

  buttonUl() {
    return this.createButton('fa-list-ul', this.handleUl.bind(this), 'Add a bulleted list');
  }

  buttonOl() {
    return this.createButton('fa-list-ol', this.handleOl.bind(this), 'Add a numbered list');
  }

  buttonBold() {
    return this.createButton('fa-bold', this.handleBold.bind(this), 'Add bold text (cmd + b)');
  }

  buttonItalic() {
    return this.createButton('fa-italic', this.handleItalic.bind(this), 'Add italic text (cmd + i)');
  }

  buttonQuote() {
    return this.createButton('fa fa-quote-left', this.handleQuote.bind(this), 'Insert a quote');
  }

  buttonLink() {
    return this.createButton('fa-link', this.handleLink.bind(this), 'Add a link (cmd + k)');
  }

  buttonStrikeThrough() {
    return this.createButton('fa-strikethrough', this.handleStrikeThrough.bind(this), 'Add strike through text');
  }

  buttonCode() {
    return this.createButton('fa-code', this.handleCode.bind(this), 'Insert code');
  }

  buttonHeader(number) {
    return this.createButton('fa-header', this.handleHeader.bind(this, number), 'Insert header ' + number, number);
  }

  handleUl() {
    this.insertLeftTag('-');
  }

  handleOl() {
    this.insertLeftTag('1.');
  }

  handleBold() {
    this.insertTag('**');
  }

  handleItalic() {
    this.insertTag('_');
  }

  handleQuote() {
    this.insertLeftTag('>');
  }

  handleLink() {
    this.insertLinkTag();
  }

  handleStrikeThrough() {
    this.insertTag('~~');
  }

  handleCode() {
    this.insertTag('`');
  }

  handleHeader(number) {
    const headerTags = {
      1: '#',
      2: '##',
      3: '###',
    };

    this.insertLeftTag(headerTags[number]);
  }

  getCurrentSelection() {
    const editor = this.props.editor;

    editor.focus();
    return {
      start: editor.selectionStart,
      end:   editor.selectionEnd,
      content: {
        before: editor.value.substr(0, editor.selectionStart),
        target: editor.value.substr(editor.selectionStart, (editor.selectionEnd - editor.selectionStart)),
        after:  editor.value.substr(editor.selectionEnd),
      }
    };
  }

  reSelect(start, end) {
    const editor = this.props.editor;
    editor.setSelectionRange(start, end);
    editor.focus();
  }

  replaceEditorValue(start, end, newText) {
    const editor = this.props.editor;
    editor.setSelectionRange(start, end);
    editor.focus();

    let inserted = false;
    try {
      // Chrome, Safari
      inserted = document.execCommand('insertText', false, newText);
    } catch (e) {
      inserted = false;
    }

    if (!inserted) {
      // Firefox
      editor.value = editor.value.substr(0, start) + newText + editor.value.substr(end);
    }
  }

  insertTag(tag) {
    const currentSelection = this.getCurrentSelection();

    const editor = this.props.editor;
    const preText  = editor.value.substr(currentSelection.start - tag.length, tag.length);
    const postText = editor.value.substr(currentSelection.end, tag.length);

    let newText = '';
    let replaceStart = 0;
    let replaceEnd   = 0;
    let selectStart  = 0;
    let selectEnd    = 0;

    if (preText === tag && postText === tag) {
      // Already inserted
      newText = currentSelection.content.target;
      replaceStart = currentSelection.start - tag.length;                  // |**STRING**
      replaceEnd   = currentSelection.end   + tag.length;                  //  **STRING**|
      selectStart  = currentSelection.start - tag.length;                  //   |STRING
      selectEnd    = selectStart + currentSelection.content.target.length; //    STRING|
    } else {
      // Not yet inserted
      newText = tag + currentSelection.content.target + tag;
      replaceStart = currentSelection.start;                               //   |STRING
      replaceEnd   = currentSelection.end;                                 //    STRING|
      selectStart  = currentSelection.start + tag.length;                  // **|STRING**
      selectEnd    = selectStart + currentSelection.content.target.length; //  **STRING|**
    }

    this.replaceEditorValue(replaceStart, replaceEnd, newText);
    this.reSelect(selectStart, selectEnd);
  }

  insertLeftTag(tag) {
    const currentSelection = this.getCurrentSelection();

    const editor = this.props.editor;
    const preText = editor.value.substr(currentSelection.start - tag.length - 1, tag.length);

    let newText = '';
    let replaceStart = 0;
    let replaceEnd   = 0;
    let selectStart  = 0;
    let selectEnd    = 0;

    if (preText === tag) {
      // Already inserted
      const regexp = new RegExp("\n" + tag + ' ', 'g');
      newText = currentSelection.content.target.replace(regexp, "\n");
      replaceStart = currentSelection.start - tag.length - 1;
      replaceEnd   = currentSelection.end;
      selectStart  = currentSelection.start - tag.length - 1;
      selectEnd    = selectStart + newText.length;
    } else {
      newText = tag + ' ' + currentSelection.content.target.replace(/\n/g, "\n" + tag + ' ');

      const regexp = new RegExp("\n" + tag + ' $');
      newText = newText.replace(regexp, "\n");

      replaceStart = currentSelection.start;
      replaceEnd   = currentSelection.end;
      selectStart  = currentSelection.start + tag.length + 1;
      selectEnd    = selectStart + newText.length - tag.length - 1;
    }

    this.replaceEditorValue(replaceStart, replaceEnd, newText);
    this.reSelect(selectStart, selectEnd);
  }

  insertLinkTag() {
    const currentSelection = this.getCurrentSelection();

    const editor = this.props.editor;

    let newText = '[' + currentSelection.content.target + '](url)';
    let replaceStart = currentSelection.start;
    let replaceEnd   = currentSelection.end;
    let selectStart  = currentSelection.end + 3; // [STRING](|url)
    let selectEnd    = selectStart + 3;          // [STRING](url|)

    this.replaceEditorValue(replaceStart, replaceEnd, newText);
    this.reSelect(selectStart, selectEnd);
  }

  render() {
    return (
      <div className="markdown-edit-helper">
        <div>
          {this.buttonBold()}
          {this.buttonItalic()}
          {this.buttonLink()}
          {this.buttonStrikeThrough()}
          {this.buttonCode()}
          {this.buttonHeader(1)}
          {this.buttonHeader(2)}
          {this.buttonHeader(3)}
          {this.buttonQuote()}
          {this.buttonUl()}
          {this.buttonOl()}
        </div>
      </div>
    );
  }
}

MardownEditHelper.propTypes = {
  editor: React.PropTypes.element.isRequired,
};

MardownEditHelper.defaultProps = {
};

export default MardownEditHelper;
