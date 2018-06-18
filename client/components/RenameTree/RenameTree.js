import React from 'react'
import { Button, Modal, FormGroup, ControlLabel, FormControl, InputGroup } from 'react-bootstrap'
import { translate } from 'react-i18next'
import Icon from '../Common/Icon'

class RenameTree extends React.Component {
  constructor(props) {
    super(props)

    this.renderTree = this.renderTree.bind(this)
    this.handleShow = this.handleShow.bind(this)
    this.handleClose = this.handleClose.bind(this)
    this.handleChange = this.handleChange.bind(this)
    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleError = this.handleError.bind(this)
    this.convertPathMapToTree = this.convertPathMapToTree.bind(this)
    this.checkTreeRenamable = this.checkTreeRenamable.bind(this)

    this.state = {
      show: false,
      newPath: RenameTree.getPath({ removeTrailingSlash: true }),
      pathMap: {},
      error: null,
      errors: {},
      renamable: false,
      removing: false,
      timeoutId: null,
    }

    // TODO: DropdownのReact化の際に消す？
    $("a[data-target='#renameTree']").click(this.handleShow)
  }

  static getPath(options = { removeTrailingSlash: false }) {
    const { removeTrailingSlash } = options
    let path
    path = decodeURIComponent(location.pathname)
    if (removeTrailingSlash) {
      path = RenameTree.removeTrailingSlash(path)
    }
    return path
  }

  static addTrailingSlash(string) {
    return string.endsWith('/') ? string : `${string}/`
  }

  static removeTrailingSlash(string) {
    return string.endsWith('/') ? string.substring(0, string.length - 1) : string
  }

  convertPathMapToTree(pathMap) {
    let tree = {}
    const generateNode = (path, name, children = {}) => ({
      [path]: { path, name, children },
    })
    const generateRoot = path => generateNode(path, path)
    const assignRecurcive = (tree, parents, path, name) => {
      if (parents.length === 0) {
        return generateNode(path, name)
      }
      let parent = parents[0]
      let children = tree[parent].children
      name = path.replace(parent, '')
      return {
        ...tree,
        [parent]: {
          ...tree[parent],
          children: {
            ...children,
            ...assignRecurcive(children, parents.slice(1), path, name),
          },
        },
      }
    }
    const getParents = (paths, path) => {
      return paths
        .filter(function(p) {
          return path !== p && path.startsWith(RenameTree.removeTrailingSlash(p)) && !p.endsWith('/')
        })
        .sort()
    }
    Object.keys(pathMap)
      .sort()
      .forEach(function(path, index, paths) {
        tree = index === 0 ? generateRoot(path) : assignRecurcive(tree, getParents(paths, path), path)
      })
    return tree
  }

  renderTree(pathMap, errors) {
    const tree = this.convertPathMapToTree(pathMap)

    const getErrors = function(path) {
      return errors[pathMap[path]]
    }

    const renderRoot = function(tree) {
      return Object.values(tree).map(renderNode)
    }

    const renderChanges = function(path) {
      return (
        <code className="changes">
          <Icon name="arrow-right" /> {pathMap[path]}
        </code>
      )
    }

    const { t } = this.props
    const renderNodeErrors = function(nodeErrors) {
      const DottedLine = () => (
        <div className="dotted-line">
          <svg>
            <line x1="0" x2="100%" y2="50%" y1="50%" />
          </svg>
        </div>
      )
      return (
        <span className="errors">
          <DottedLine />
          {nodeErrors.map(e => t(e)).join(', ')}
        </span>
      )
    }

    const renderNode = function({ path, name, children }) {
      const isRoot = name === path
      const isEmpty = o => Object.keys(o).length === 0
      const nodeErrors = getErrors(path)
      const hasChildren = !isEmpty(children)
      const hasNodeErrors = nodeErrors !== undefined && nodeErrors.length > 0
      return (
        <ul className="tree" key={path}>
          <li className="leaf">
            {name} {isRoot && renderChanges(path)}
            {hasNodeErrors && renderNodeErrors(nodeErrors)}
          </li>
          {hasChildren && <li>{renderRoot(children)}</li>}
        </ul>
      )
    }

    return renderRoot(tree)
  }

  handleClose() {
    this.setState({ show: false })
  }

  handleShow() {
    this.setState({ show: true })
  }

  handleChange(e) {
    clearTimeout(this.state.timeoutId)
    const timeoutId = setTimeout(() => this.checkTreeRenamable(), 600)
    this.setState({ newPath: e.target.value, timeoutId })
  }

  async checkTreeRenamable() {
    const { crowi } = this.props
    const { newPath } = this.state
    const path = RenameTree.getPath({ removeTrailingSlash: true })
    try {
      const data = await crowi.apiPost('/pages.checkTreeRenamable', { path, new_path: newPath })
      const { path_map: pathMap } = data
      // ${pathMap} has not ${path} key if location is PageList
      pathMap[path] = newPath
      this.setState({ pathMap, renamable: true, error: null })
    } catch (error) {
      this.handleError(error)
    }
  }

  async handleSubmit() {
    const { crowi } = this.props
    const { newPath } = this.state
    const path = RenameTree.getPath({ removeTrailingSlash: true })
    const createRedirect = 1
    this.setState({ removing: true })
    try {
      const data = await crowi.apiPost('/pages.renameTree', {
        path,
        new_path: newPath,
        create_redirect: createRedirect,
      })
      const { pages } = data
      const urls = pages.map(({ path }) => path)
      const exists = path => urls.includes(path)
      const redirect = to => () => (top.location.href = to)
      const pageUrl = `${newPath}?redirectFrom=${RenameTree.getPath()}`
      const listUrl = RenameTree.addTrailingSlash(newPath)
      setTimeout(redirect(exists(newPath) ? pageUrl : listUrl), 1000)
    } catch (error) {
      this.handleError(error)
    }
  }

  handleError(error) {
    const { info } = error
    let newState = { renamable: false, error: error.message, removing: false }
    if (info && Object.keys(info).length > 0) {
      const { path_map: pathMap, errors } = info
      this.setState({ ...newState, pathMap, errors })
    } else {
      this.setState(newState)
    }
  }

  render() {
    const { show, newPath, pathMap, error, errors, renamable, removing } = this.state
    const { t } = this.props
    return (
      <Modal show={show} onHide={this.handleClose}>
        <Modal.Header closeButton>
          <Modal.Title id="contained-modal-title-lg">{t('Rename tree')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <FormGroup>
            <ControlLabel>{t('Current page name')}</ControlLabel>
            <code>{RenameTree.getPath()}</code>
          </FormGroup>
          <FormGroup>
            <ControlLabel>{t('New page name')}</ControlLabel>
            <InputGroup>
              <InputGroup.Addon>{location.origin}</InputGroup.Addon>
              <FormControl name="new_path" value={newPath} onChange={this.handleChange} />
            </InputGroup>
          </FormGroup>
          <div>{this.renderTree(pathMap, errors)}</div>
        </Modal.Body>

        <Modal.Footer>
          {error && (
            <p>
              <small className="pull-left alert-danger">
                <Icon name="times-circle" /> {t(error)}
              </small>
            </p>
          )}
          {removing && (
            <p>
              <small className="pull-left">
                <img src="/images/loading_s.gif" /> Page tree moved! Redirecting to new location.
              </small>
            </p>
          )}
          <Button type="submit" bsStyle="primary" onClick={this.handleSubmit} disabled={!renamable}>
            Rename!
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }
}

export default translate()(RenameTree)
