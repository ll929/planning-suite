import { hot } from 'react-hot-loader'
import { map } from 'rxjs/operators'
import PropTypes from 'prop-types'
import React, { useEffect, useState } from 'react'
import { ApolloProvider } from 'react-apollo'
import BigNumber from 'bignumber.js'

import { useAragonApi } from '@aragon/api-react'
import { AppView, Main, observe, TabBar } from '@aragon/ui'

import { useAuthService } from '../../hooks'
import {
  REQUESTING_GITHUB_TOKEN,
  REQUESTED_GITHUB_TOKEN_SUCCESS,
  REQUESTED_GITHUB_TOKEN_FAILURE,
} from '../../store/eventTypes'
import {
  checkForCode,
  getURLParam,
  getToken,
  githubPopup,
  initApolloClient,
  STATUS,
} from '../../utils/github'
import { CURRENT_USER } from '../../utils/gql-queries'
import { ipfsAdd, computeIpfsString } from '../../utils/ipfs-helpers'
import { Issues, Overview, Settings } from '../Content'
import PanelManager, { PANELS } from '../Panel'
import { AppContent, AppTitleButton } from '.'
import ErrorBoundary from './ErrorBoundary'

const SCREENS = [ 'Overview', 'Issues', 'Settings' ]

const ProjectsApp = ({
  api,
  bountySettings = {},
  github = { status: STATUS.INITIAL },
  issues = [],
  repos = [],
  tokens = [],
}) => {
  const [ screen, setScreen ] = useState(0)
  const [ panel, setPanel ] = useState()
  const [ panelProps, setPanelProps ] = useState()
  const [ currentGithubUser, setCurrentGithubUser ] = useState()
  const [ popup, setPopup ] = useState()
  const [ githubLoading, setGithubLoading ] = useState(false)
  const [ apolloClient, setApolloClient ] = useState(
    initApolloClient(github.token || '')
  )

  const { authURI, clientId, redirectURI } = useAuthService()

  useEffect(() => {
    /**
     * Acting as the redirect target it looks up for 'code' URL param on component mount
     * if it detects the code then sends to the opener window
     * via postMessage with 'popup' as origin and close the window (usually a popup)
     */
    const code = getURLParam('code')
    code &&
      window.opener.postMessage(
        { from: 'popup', name: 'code', value: code },
        '*'
      )
    window.close()
  })

  useEffect(
    () => {
      const initializeApollo = async () => {
        if (github.status === STATUS.AUTHENTICATED) {
          const client = initApolloClient(github.token)
          const data = await client.query({
            query: CURRENT_USER,
          })
          setApolloClient(client)
          setCurrentGithubUser(data.viewer)
        }
      }
      initializeApollo()
    },
    [github]
  )

  const closePanel = () => {
    setPanel(null)
  }

  // TODO: memoize:
  // const loadPanelProps = memo(PANEL_PROPS[panel])

  // Main functions TODO: move to reducer

  /**
   * Probably external candidate functions
   */

  const handlePopupMessage = async message => {
    if (message.data.from !== 'popup') return
    if (message.data.name === 'code') {
      // TODO: Optimize the listeners lifecycle, ie: remove on unmount
      window.removeEventListener('message', handlePopupMessage)

      const code = message.data.value
      let event, status, token

      try {
        event = REQUESTED_GITHUB_TOKEN_SUCCESS
        status = STATUS.AUTHENTICATED
        token = await getToken({ authURI, code })
      } catch (err) {
        console.log('handlePopupMessage', err)
        event = REQUESTED_GITHUB_TOKEN_FAILURE
        status = STATUS.FAILED
        token = null
      }
      console.log(
        'caching new github status',
        event,
        status,
        token,
        api.cache('hello', { field: true })
      )
      setGithubLoading(false)
      setPanelProps({
        onCreateProject,
        status,
      })
      api.cache('github', {
        event,
        status,
        token,
      })
    }
  }

  const handleGithubSignIn = () => {
    // The popup is launched, its ref is checked and saved in the state in one step
    setPopup(githubPopup({ clientId, popup, redirectURI }))
    setGithubLoading(true)
    // Listen for the github redirection with the auth-code encoded as url param
    window.addEventListener('message', handlePopupMessage)
  }

  /**
   * Form submission functions (contract calls)
   */

  const onCreateProject = ({ owner, project }) => {
    closePanel()
    api.addRepo(web3.toHex(project), web3.toHex(owner))
  }

  const onRemoveProject = project => {
    api.removeRepo(web3.toHex(project))
    // TODO: Toast feedback here maybe
  }

  const onReviewWork = async (state, issue) => {
    // new IPFS data is old data plus state returned from the panel
    const ipfsData = issue.workSubmissions[issue.workSubmissions.length - 1]
    ipfsData.review = state
    const requestIPFSHash = await ipfsAdd(ipfsData)

    closePanel()
    api.reviewSubmission(
      web3.toHex(issue.repoId),
      issue.number,
      issue.workSubmissions.length - 1,
      state.accepted,
      requestIPFSHash
    )
  }

  const onSubmitBountyAllocation = async (issues, description) => {
    closePanel()

    // computes an array of issues and denests the actual issue object for smart contract
    const issuesArray = []
    const bountySymbol = bountySettings.bountyCurrency

    let bountyToken, bountyDecimals

    tokens.forEach(token => {
      if (token.symbol === bountySymbol) {
        bountyToken = token.addr
        bountyDecimals = token.decimals
      }
    })

    for (let key in issues) issuesArray.push({ key: key, ...issues[key] })

    const ipfsString = await computeIpfsString(issuesArray)

    const idArray = issuesArray.map(issue => web3.toHex(issue.repoId))
    const numberArray = issuesArray.map(issue => issue.number)
    const bountyArray = issuesArray.map(issue =>
      BigNumber(issue.size)
        .times(10 ** bountyDecimals)
        .toString()
    )
    const tokenArray = new Array(issuesArray.length).fill(bountyToken)
    const dateArray = new Array(issuesArray.length).fill(Date.now() + 8600)
    const booleanArray = new Array(issuesArray.length).fill(true)

    console.log('Submit issues:', issuesArray)
    api.addBounties(
      idArray,
      numberArray,
      bountyArray,
      dateArray,
      booleanArray,
      tokenArray,
      ipfsString,
      description
    )
  }

  /**
   * Panel loading functions
   */

  const newBountyAllocation = issues => {
    setPanel(PANELS.FundIssues)
    // TODO: use reducer for this and memoize
    setPanelProps({
      issues,
      onSubmit: onSubmitBountyAllocation,
      bountySettings,
      tokens,
      closePanel,
    })
  }

  const newIssue = () => {
    const reposManaged =
      repos.map(repo => ({
        name: repo.metadata.name,
        id: repo.data._repo,
      })) || 'No repos'
    const reposIds = repos.map(repo => repo.data.repo) || []

    setPanel(PANELS.NewIssue)
    setPanelProps({
      reposManaged,
      closePanel,
      reposIds,
    })
  }

  // TODO: Review
  // This is breaking RepoList loading sometimes preventing show repos after login
  const newProject = () => {
    const reposAlreadyAdded = repos ? repos.map(repo => repo.data._repo) : []

    setPanel(PANELS.NewProject)
    setPanelProps({
      onCreateProject: createProject,
      onGithubSignIn: handleGithubSignIn,
      reposAlreadyAdded,
      status: status,
    })
  }

  const reviewWork = issue => {
    setPanel(PANELS.ReviewWork)
    setPanelProps({ issue, onReviewWork, currentGithubUser })
  }

  /**
   * Functions to refactor into memoized versions
   */
  const contentData = [
    {
      tabName: 'Overview',
      TabComponent: Overview,
      tabButton: {
        caption: 'New Project',
        onClick: newProject,
        disabled: () => false,
        hidden: () => false,
      },
    },
    {
      tabName: 'Issues',
      TabComponent: Issues,
      tabButton: {
        caption: 'New Issue',
        onClick: newIssue,
        disabled: () => (projects.length ? false : true),
        hidden: () => (projects.length ? false : true),
      },
    },
    {
      tabName: 'Settings',
      TabComponent: Settings,
    },
  ]

  const appTitleButton =
    github.status === STATUS.AUTHENTICATED && contentData[screen].tabButton
      ? contentData[screen].tabButton
      : null

  return (
    <Main assetsUrl="./aragon-ui">
      {appTitleButton &&
        !appTitleButton.hidden() && (
        <AppTitleButton
          caption={appTitleButton.caption}
          onClick={appTitleButton.onClick}
          disabled={appTitleButton.disabled()}
        />
      )}
      <AppView
        title="Projects"
        tabs={<TabBar items={SCREENS} selected={screen} onSelect={setScreen} />}
      >
        <ApolloProvider client={apolloClient}>
          <ErrorBoundary>
            <AppContent
              activeIndex={screen}
              app={api}
              bountyIssues={issues}
              bountySettings={bountySettings}
              changeActiveIndex={setScreen}
              contentData={contentData}
              githubCurrentUser={currentGithubUser}
              githubLoading={githubLoading}
              onAllocateBounties={newBountyAllocation}
              // onCurateIssues={curateIssues}
              onLogin={handleGithubSignIn}
              onNewIssue={newIssue}
              onNewProject={newProject}
              // onReviewApplication={reviewApplication}
              onRemoveProject={onRemoveProject}
              // onRequestAssignment={requestAssignment}
              onReviewWork={reviewWork}
              // onSubmitWork={submitWork}
              projects={repos}
              status={github.status}
              tokens={tokens}
            />

            <PanelManager
              onClose={closePanel}
              activePanel={panel}
              {...panelProps}
            />
          </ErrorBoundary>
        </ApolloProvider>
      </AppView>
    </Main>
  )
}

ProjectsApp.propTypes = {
  api: PropTypes.object,
  appState: PropTypes.object,
  repos: PropTypes.arrayOf(PropTypes.object),
}

export default hot(module)(() => {
  const { api, appState } = useAragonApi()
  return <ProjectsApp api={api} {...appState} />
})
