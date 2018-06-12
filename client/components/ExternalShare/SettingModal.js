import React from "react";
import PropTypes from "prop-types";
import {
  Button,
  Checkbox,
  Col,
  ControlLabel,
  Form,
  FormControl,
  FormGroup,
  Modal,
  Radio
} from "react-bootstrap";

export default class SettingModal extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      shareId: null,
      secretKeyword: null,
      restricted: false
    };

    this.setRestricted = this.setRestricted.bind(this);
    this.setSecretKeyword = this.setSecretKeyword.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  componentWillReceiveProps(nextProps) {
    const { activeShare: share = {} } = nextProps;
    const { id: shareId, secretKeyword = "" } = share;

    this.setState({
      shareId,
      secretKeyword,
      restricted: !!secretKeyword
    });
  }

  setRestricted(value) {
    return () => {
      this.setState({ restricted: value });
    };
  }

  setSecretKeyword(e) {
    this.setState({ secretKeyword: e.target.value });
  }

  canSubmit() {
    const { restricted, secretKeyword } = this.state;
    if (!restricted) {
      return true;
    }
    return !!secretKeyword && secretKeyword.length > 0;
  }

  handleSubmit(e) {
    const { shareId, secretKeyword, restricted } = this.state;
    this.props.crowi.apiPost("/shares/secretKeyword", {
      share_id: shareId,
      secret_keyword: restricted ? secretKeyword : null
    });
  }

  render() {
    const { show, handleClose } = this.props;
    const { restricted, secretKeyword } = this.state;
    return (
      <Modal className="share-setting-modal" show={show} onHide={handleClose}>
        <Modal.Header closeButton>
          <Modal.Title>リンクの設定</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="form-horizontal">
            <FormGroup controlId="restricted">
              <Col componentClass={ControlLabel} sm={2}>
                閲覧制限
              </Col>
              <Col sm={10}>
                <Radio
                  name="restricted"
                  onClick={this.setRestricted(false)}
                  defaultChecked={!restricted}
                >
                  リンクを知っている人
                </Radio>
                <Radio
                  name="restricted"
                  onClick={this.setRestricted(true)}
                  defaultChecked={restricted}
                >
                  秘密のキーワードを知っている人
                </Radio>
                {restricted && (
                  <FormControl
                    className="secret-keyword"
                    type="text"
                    placeholder="秘密のキーワード"
                    onChange={this.setSecretKeyword}
                    defaultValue={secretKeyword}
                  />
                )}
              </Col>
            </FormGroup>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={this.handleSubmit} disabled={!this.canSubmit()}>
            設定を保存
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}

SettingModal.propTypes = {
  share: PropTypes.object.isRequired,
  show: PropTypes.bool.isRequired,
  handleClose: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired
};
SettingModal.defaultProps = {
  show: false
};
