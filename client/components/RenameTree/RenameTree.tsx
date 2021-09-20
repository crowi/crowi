import React from 'react'
import { Button, Modal, ModalHeader, ModalBody, ModalFooter, InputGroup, InputGroupAddon, Input, Label } from 'reactstrap'
import { withTranslation, WithTranslation } from 'react-i18next'
import Icon from '../Common/Icon'
import Crowi from 'client/util/Crowi'
import { Page } from 'client/types/crowi'

interface Props extends WithTranslation {
  crowi: Crowi
}

interface State {
  show: boolean
  newPath: string
  pathMap: {}
  error: string | null
  errors: {}
  renamable: boolean
  removing: boolean
  timeoutId: number | null
}

interface PathMap {
  [name: string]: string
}

interface Node {
  path: string
  name: string
  children: Tree
}

interface Tree {
  [name: string]: Node
}

interface Errors {
  [path: string]: string[]
}

class RenameTree extends React.Component<Props, State> {
  constructor(props: Props) {
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

  static addTrailingSlash(string: string) {
    return string.endsWith('/') ? string : `${string}/`
  }

  static removeTrailingSlash(string: string) {
    return string.endsWith('/') ? string.substring(0, string.length - 1) : string
  }

  convertPathMapToTree(pathMap: PathMap) {
    let tree: Tree = {}
    const generateNode = (path: string, name: string, children = {}): Tree => ({ [path]: { path, name, children } })
    const generateRoot = (path: string) => generateNode(path, path)
    const assignRecurcive = (tree: Tree, parents: string[], path: string, name = ''): Tree => {
      if (parents.length === 0) {
        return generateNode(path, name)
      }
      const parent = parents[0]
      const children = tree[parent].children
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
    const treeName = (path: string) => path.replace(/\\/g, '/').replace(/\/[^/]*\/?$/, '')
    const getParents = (paths: string[], path: string) =>
      paths
        .filter(
          (p) =>
            path !== p &&
            // add '/' to check strictly: ex: '/aaa' must not be matched to '/aaa_ccc/yes'
            path.startsWith(RenameTree.removeTrailingSlash(p) + '/') &&
            // no same rank
            treeName(p) !== treeName(path) &&
            !p.endsWith('/'),
        )
        .sort()

    Object.keys(pathMap)
      .sort()
      .forEach((path, index, paths) => (tree = index === 0 ? generateRoot(path) : assignRecurcive(tree, getParents(paths, path), path)))

    return tree
  }

  renderTree(pathMap: PathMap, errors: Errors) {
    const tree: Tree = this.convertPathMapToTree(pathMap)

    const getErrors = (path: string) => errors[pathMap[path]]

    const renderRoot = (tree: Tree) => Object.values(tree).map(renderNode)

    const renderChanges = (path: string) => (
      <code className="changes">
        <Icon name="arrowRight" /> {pathMap[path]}
      </code>
    )

    const { t } = this.props
    const DottedLine = () => (
      <div className="dotted-line">
        <svg>
          <line x1="0" x2="100%" y2="50%" y1="50%" />
        </svg>
      </div>
    )
    const renderNodeErrors = (nodeErrors: string[]) => (
      <span className="errors">
        <DottedLine />
        {nodeErrors.map((e: string) => t(e)).join(', ')}
      </span>
    )

    const renderNode = function ({ path, name, children }: Node) {
      const isRoot = name === path
      const isEmpty = (o: any) => Object.keys(o).length === 0
      const nodeErrors = getErrors(path)
      const hasChildren = !isEmpty(children)
      const hasNodeErrors = nodeErrors !== undefined && nodeErrors.length > 0
      return (
        <ul className="tree" key={path}>
          <li className="leaf">
            <a href={`${path}`}>{name}</a> {isRoot && renderChanges(path)}
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

  handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (this.state.timeoutId) {
      clearTimeout(this.state.timeoutId)
    }
    const timeoutId = window.setTimeout(() => this.checkTreeRenamable(), 600)
    this.setState({ newPath: e.target.value, timeoutId })
  }

  normalizePathMap(pathMap: PathMap, newPath: string): PathMap {
    const path = RenameTree.getPath({ removeTrailingSlash: true })
    const portalPath = `${path}/`
    // ${pathMap} has not ${path} key if location is PageList
    pathMap[path] = newPath
    delete pathMap[portalPath]
    return pathMap
  }

  async checkTreeRenamable() {
    const { crowi } = this.props
    const { newPath } = this.state
    const path = RenameTree.getPath({ removeTrailingSlash: true })
    try {
      const data = await crowi.apiPost('/pages.checkTreeRenamable', { path, new_path: newPath })
      const pathMap = this.normalizePathMap(data.path_map, newPath)
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
      const { pages }: { pages: Page[] } = data
      const urls = pages.map(({ path }) => path)
      const exists = (path: string) => urls.includes(path)
      const redirect = (to: string) => () => (location.href = to)
      const pageUrl = `${newPath}?redirectFrom=${RenameTree.getPath()}`
      const listUrl = RenameTree.addTrailingSlash(newPath)
      setTimeout(redirect(exists(newPath) ? pageUrl : listUrl), 1000)
    } catch (error) {
      this.handleError(error)
    }
  }

  handleError(error: Error) {
    const { info } = error
    const newState = { renamable: false, error: error.message, removing: false }
    if (info && Object.keys(info).length > 0) {
      const { errors }: { errors: Errors } = info
      const { newPath } = this.state
      const pathMap = this.normalizePathMap(info.path_map, newPath)
      this.setState({ ...newState, pathMap, errors })
    } else {
      this.setState(newState)
    }
  }

  render() {
    const { show, newPath, pathMap, error, errors, renamable, removing } = this.state
    const { t } = this.props
    return (
      <Modal isOpen={show} toggle={this.handleClose} size="lg">
        <ModalHeader toggle={this.handleClose}>{t('Rename tree')}</ModalHeader>
        <ModalBody>
          <div className="mb-2">
            <span className="mr-2">{t('Current page name')}</span>
            <code>{RenameTree.getPath()}</code>
          </div>
          <InputGroup>
            <Label for="newPath">{t('New page name')}</Label>
            <InputGroup>
              <InputGroupAddon addonType="prepend">{location.origin}</InputGroupAddon>
              <Input id="newPath" name="new_path" defaultValue={newPath} onChange={this.handleChange} />
            </InputGroup>
          </InputGroup>
          <div>{this.renderTree(pathMap, errors)}</div>
        </ModalBody>
        <ModalFooter>
          {error && (
            <p>
              <small className="mr-auto alert-danger">
                <Icon name="alert" /> {t(error)}
              </small>
            </p>
          )}
          {removing && (
            <p>
              <small className="mr-auto">
                <Icon name="loading" spin /> Page tree moved! Redirecting to new location.
              </small>
            </p>
          )}
          <Button type="submit" color="primary" onClick={this.handleSubmit} disabled={!renamable || removing}>
            Rename!
          </Button>
        </ModalFooter>
      </Modal>
    )
  }
}

export default withTranslation()(RenameTree)
