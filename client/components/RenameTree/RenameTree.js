import React from "react";
import {
  Button,
  Modal,
  FormGroup,
  ControlLabel,
  FormControl,
  InputGroup
} from "react-bootstrap";
import { translate } from "react-i18next";
import Icon from "../Common/Icon";

class RenameTree extends React.Component {
  constructor(props) {
    super(props);

    this.renderTree = this.renderTree.bind(this);
    this.handleShow = this.handleShow.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);

    this.state = {
      show: false,
      newPath: location.pathname,
      pathMap: {},
      errors: {}
    };

    // TODO: DropdownのReact化の際に消す？
    $("a[data-target='#renameTree']").click(this.handleShow);
  }

  convertPathMapToTree(pathMap) {
    let tree = {};
    const generateNode = (path, name, children = {}) => ({
      [path]: { path, name, children }
    });
    const generateRoot = path => generateNode(path, path);
    const assignRecurcive = (tree, parents, path, name) => {
      if (parents.length === 0) {
        return generateNode(path, name);
      }
      let parent = parents[0];
      let children = tree[parent].children;
      name = path.replace(parent, "");
      return {
        ...tree,
        [parent]: {
          ...tree[parent],
          children: {
            ...children,
            ...assignRecurcive(children, parents.slice(1), path, name)
          }
        }
      };
    };
    const getParents = (paths, path) => {
      const removeTrailingSlash = string =>
        string.endsWith("/") ? string.substring(0, string.length - 1) : string;
      return paths
        .filter(function(p) {
          return (
            path !== p &&
            path.startsWith(removeTrailingSlash(p)) &&
            !p.endsWith("/")
          );
        })
        .sort();
    };
    Object.keys(pathMap)
      .sort()
      .forEach(function(path, index, paths) {
        tree =
          index === 0
            ? generateRoot(path)
            : assignRecurcive(tree, getParents(paths, path), path);
      });
    return tree;
  }

  renderTree(pathMap, errors) {
    const tree = this.convertPathMapToTree(pathMap);

    const getErrors = function(path) {
      return errors[pathMap[path]];
    };

    const renderRoot = function(tree) {
      return Object.values(tree).map(renderNode);
    };

    const renderChanges = function(path) {
      return (
        <code className="changes">
          <Icon name="arrow-right" /> {pathMap[path]}
        </code>
      );
    };

    const renderNodeErrors = function(nodeErrors) {
      const DottedLine = () => (
        <div className="dotted-line">
          <svg>
            <line x1="0" x2="100%" y2="50%" y1="50%" />
          </svg>
        </div>
      );
      return (
        <span className="errors">
          <DottedLine />
          {nodeErrors.join(", ")}
        </span>
      );
    };

    const renderNode = function({ path, name, children }) {
      const isRoot = name === path;
      const isEmpty = o => Object.keys(o).length === 0;
      const nodeErrors = getErrors(path);
      const hasChildren = !isEmpty(children);
      const hasNodeErrors = nodeErrors !== undefined && nodeErrors.length > 0;
      return (
        <ul className="tree" key={path}>
          <li className="leaf">
            {name} {isRoot && renderChanges(path)}
            {hasNodeErrors && renderNodeErrors(nodeErrors)}
          </li>
          {hasChildren && <li>{renderRoot(children)}</li>}
        </ul>
      );
    };

    return renderRoot(tree);
  }

  handleClose() {
    this.setState({ show: false });
  }

  handleShow() {
    this.setState({ show: true });
  }

  handleChange(e) {
    this.setState({ newPath: e.target.value });
  }

  async handleSubmit() {
    const { crowi, pageId: page_id } = this.props;
    const { newPath: new_path } = this.state;
    try {
      const data = await crowi.apiPost("/pages.checkTreeRenamable", {
        page_id,
        new_path
      });
      const { path_map: pathMap } = data;
      this.setState({ pathMap });
    } catch (error) {
      const { info } = error;
      if (info) {
        const { path_map: pathMap, errors } = info;
        this.setState({ pathMap, errors });
      }
    }
  }

  render() {
    const { show, newPath, pathMap, errors } = this.state;
    const { t } = this.props;
    return (
      <Modal show={show} onHide={this.handleClose}>
        <Modal.Header closeButton>
          <Modal.Title id="contained-modal-title-lg">
            {t("Rename tree")}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <FormGroup>
            <ControlLabel>{t("Current page name")}</ControlLabel>
            <code>{location.pathname}</code>
          </FormGroup>
          <FormGroup>
            <ControlLabel>{t("New page name")}</ControlLabel>
            <InputGroup>
              <InputGroup.Addon>{location.origin}</InputGroup.Addon>
              <FormControl
                name="new_path"
                value={newPath}
                onChange={this.handleChange}
              />
            </InputGroup>
          </FormGroup>
          <div>{this.renderTree(pathMap, errors)}</div>
        </Modal.Body>

        <Modal.Footer>
          <Button type="submit" bsStyle="primary" onClick={this.handleSubmit}>
            Rename!
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}

export default translate()(RenameTree);
