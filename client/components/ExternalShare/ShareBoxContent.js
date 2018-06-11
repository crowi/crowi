import React from "react";
import PropTypes from "prop-types";
import { Button, InputGroup, FormControl } from 'react-bootstrap';

export default class ShareBoxContent extends React.Component {
  constructor(props) {
    super(props);

    this.selectAction = this.selectAction.bind(this);
    this.createRef = this.createRef.bind(this);
    this.copyAction = this.copyAction.bind(this);
  }

  selectAction(e) {
    this.inputRef.select();
  }

  createRef(node) {
    this.inputRef = node;
  }

  copyAction(e) {
    this.inputRef.select();
    document.execCommand("copy");
  }

  render() {
    const { activeShare, isCreated } = this.props;
    if (isCreated) {
      const shareId = activeShare.id;
      const url = `${location.origin}/_share/${shareId}`;
      return (
        <div className="share-box-content">
          <InputGroup>
            <FormControl
              bsClass="copy-link form-control"
              type="text"
              defaultValue={url}
              readOnly
              onClick={this.selectAction}
              inputRef={this.createRef}
            />
            <InputGroup.Button onClick={this.copyAction}>
              <Button>Copy</Button>
            </InputGroup.Button>
          </InputGroup>
        </div>
      );
    }
    return <div className="share-box-content">まだリンクは作成されていません</div>;
  }
}

ShareBoxContent.propTypes = {
  isCreated: PropTypes.bool,
  activeShare: PropTypes.object
};
ShareBoxContent.defaultProps = {
  isCreated: false,
  activeShare: {}
};
