import * as Github from "github";
import * as probot from "probot-ts";
import {appConfig, MergeConfig} from "../default";
import {addComment, getGhLabels, getLabelsNames, match, matchLabel} from "./common";
import {Task} from "./task";

export const CONFIG_FILE = "angular-robot.yml";

// TODO(ocombe): create Typescript interfaces for each payload & DB data
export class MergeTask extends Task {
  constructor(robot: probot.Robot, db: FirebaseFirestore.Firestore) {
    super(robot, db);

    // Pushs to the repository to check for merge conflicts
    this.robot.on('push', (context: probot.Context) => this.onPush(context));
    // PR receives a new label
    this.robot.on('pull_request.labeled', (context: probot.Context) => this.onLabeled(context));
    // PR looses a label
    this.robot.on('pull_request.unlabeled', (context: probot.Context) => this.onUnlabeled(context));
    // PR updated or received a new status update from another app
    this.robot.on([
      'status',
      'pull_request.synchronize',
      // not tracking PR reviews for now, we can use pullapprove status for that
      // 'pull_request.review_requested',
      // 'pull_request_review.submitted',
      // 'pull_request_review.dismissed'
    ], (context: probot.Context) => this.updateStatus(context));
    // PR created or updated
    this.robot.on([
      'pull_request.synchronize',
      'pull_request.opened'
    ], (context: probot.Context) => this.onSynchronize(context));
    // PR closed or reopened (but content not changed)
    this.robot.on([
      'pull_request.closed',
      'pull_request.reopened'
    ], (context: probot.Context) => this.onUpdate(context));
  }

  /**
   * Checks whether the label can be added or not, and removes it if necessary. It also updates Firebase.
   * Triggered by event
   */
  async onLabeled(context: probot.Context): Promise<void> {
    const newLabel = context.payload.label.name;
    const pr: Github.PullRequest = context.payload.pull_request;
    const config = await this.getConfig(context);
    const doc = this.pullRequests.doc(pr.id.toString());
    const {owner, repo} = context.repo();
    // we need the list of labels from Github because we might be adding multiple labels at once
    // and we could overwrite some labels because of a race condition
    const labels = await getGhLabels(context.github, owner, repo, pr.number);
    // update the DB
    await doc.set({labels}, {merge: true}).catch(err => {
      throw err;
    });

    let updateStatus = false;
    let updateG3Status = false;

    if(newLabel === config.mergeLabel) {
      this.robot.log(`Checking merge label for the PR ${pr.html_url}`);

      const checks = await this.getChecksStatus(context, pr, config, labels);

      if(checks.failure.length > 0) {
        const failures = checks.failure.map(check => `&nbsp;&nbsp;&nbsp;&nbsp;![failure](https://raw.githubusercontent.com/angular/github-robot/master/assets/failing.png) ${check}`);
        const pendings = checks.pending.map(check => `&nbsp;&nbsp;&nbsp;&nbsp;![pending](https://raw.githubusercontent.com/angular/github-robot/master/assets/pending.png) ${check}`);
        const reasons = `${failures.concat(pendings).join('\n')}`;

        let body = config.mergeRemovedComment;
        if(body) {
          body = body.replace("{{MERGE_LABEL}}", config.mergeLabel).replace("{{PLACEHOLDER}}", reasons);
          addComment(context.github, owner, repo, pr.number, body).catch(err => {
            throw err;
          });
        }
      }

      updateG3Status = true;
    }

    if(matchLabel(newLabel, config.checks.requiredLabels) || matchLabel(newLabel, config.checks.forbiddenLabels)) {
      updateStatus = true;
    }

    this.updateStatus(context, updateStatus, updateG3Status, labels).catch(err => {
      throw err;
    });
  }

  /**
   * Checks what label was removed and updates the PR status if necessary. It also updates Firebase.
   * Triggered by event
   */
  async onUnlabeled(context: probot.Context): Promise<void> {
    const config = await this.getConfig(context);
    const {owner, repo} = context.repo();
    const removedLabel = context.payload.label.name;
    const pr = context.payload.pull_request;
    const doc = this.pullRequests.doc(pr.id.toString());
    // we need the list of labels from Github because we might be adding multiple labels at once
    // and we could overwrite some labels because of a race condition
    const labels = await getGhLabels(context.github, owner, repo, pr.number);
    await doc.set({labels}, {merge: true});

    if(matchLabel(removedLabel, config.checks.requiredLabels) || matchLabel(removedLabel, config.checks.forbiddenLabels)) {
      this.updateStatus(context, true, false, labels).catch(err => {
        throw err;
      });
    }
  }

  /**
   * Gets the list of labels from a PR
   */
  private async getLabels(context: probot.Context, pr?: any): Promise<Github.Label[]> {
    const {owner, repo} = context.repo();
    pr = pr || context.payload.pull_request;
    const doc = this.pullRequests.doc(pr.id.toString());
    const dbPR = await doc.get();
    let labels: Github.Label[];

    // if the PR is already in Firebase
    if(dbPR.exists) {
      labels = dbPR.data().labels;

      // if we have the labels listed in the PR
      if(labels) {
        return labels;
      }
    }

    // otherwise get the labels from Github and update Firebase
    labels = await getGhLabels(context.github, owner, repo, pr.number);
    await this.updateDbPR(context.github, owner, repo, pr.number, context.payload.repository.id, {...pr, labels});
    return labels;
  }

  /**
   * Based on the repo config, returns the list of checks that failed for this PR
   */
  private async getChecksStatus(context: probot.Context, pr: any, config: MergeConfig, labels: Github.Label[] = [], statuses?: Github.Status[]): Promise<ChecksStatus> {
    const checksStatus: ChecksStatus = {
      pending: [],
      failure: []
    };
    const labelsNames = getLabelsNames(labels);

    // Check if there is any merge conflict
    if(config.checks.noConflict) {
      // if mergeable is null, we need to get the updated status
      if(pr.mergeable === null) {
        const {owner, repo} = context.repo();
        pr = await this.updateDbPR(context.github, owner, repo, pr.number, context.payload.repository.id);
      }
      // Check if there is a conflict with the base branch
      if(!pr.mergeable) {
        checksStatus.failure.push(`conflicts with base branch "${pr.base.ref}"`);
      }
    }

    // Check if all required labels are present
    if(config.checks.requiredLabels) {
      const missingLabels = [];
      config.checks.requiredLabels.forEach(reqLabel => {
        if(!labelsNames.some(label => !!label.match(new RegExp(reqLabel)))) {
          missingLabels.push(reqLabel);
        }
      });

      if(missingLabels.length > 0) {
        checksStatus.failure.push(`missing required label${missingLabels.length > 1 ? 's' : ''}: "${missingLabels.join('", "')}"`);
      }
    }

    // Check if any forbidden label is present
    if(config.checks.forbiddenLabels) {
      const fbdLabels = [];
      config.checks.forbiddenLabels.forEach(fbdLabel => {
        if(labelsNames.some(label => !!label.match(new RegExp(fbdLabel)))) {
          fbdLabels.push(fbdLabel);
        }
      });

      if(fbdLabels.length > 0) {
        checksStatus.failure.push(`forbidden label${fbdLabels.length > 1 ? 's' : ''} detected: ${fbdLabels.join(', ')}`);
      }
    }

    // Check if we have any failed/pending external status
    statuses = statuses || await this.getStatuses(context, pr.head.sha);
    statuses.forEach(status => {
      switch(status.state) {
        case 'failure':
        case 'error':
          checksStatus.failure.push(`status "${status.context}" is failing`);
          break;
        case 'pending':
          checksStatus.pending.push(`status "${status.context}" is pending`);
          break;
      }
    });

    // Check if all required statuses are present
    if(config.checks.requiredStatuses) {
      config.checks.requiredStatuses.forEach(reqCheck => {
        if(!statuses.some(status => !!status.context.match(new RegExp(reqCheck)))) {
          checksStatus.failure.push(`missing required status "${reqCheck}"`);
        }
      });
    }

    return checksStatus;
  }

  /**
   * Updates the database when the PR is synchronized (new commit or commit force pushed)
   * Triggered by event
   */
  async onSynchronize(context: probot.Context): Promise<void> {
    const pr = context.payload.pull_request;
    const {owner, repo} = context.repo();

    await this.updateDbPR(context.github, owner, repo, pr.number, context.payload.repository.id, {
      ...pr,
      synchronized_at: new Date()
    });
    this.robot.log(`Updated synchronized date for the PR ${pr.id} (${pr.html_url})`);
  }

  /**
   * Updates Firebase data when the PR is updated
   * Triggered by event
   */
  async onUpdate(context: probot.Context): Promise<void> {
    const pr = context.payload.pull_request;
    const {owner, repo} = context.repo();

    await this.updateDbPR(context.github, owner, repo, pr.number, context.payload.repository.id, pr);
    this.robot.log(`Updated the PR ${pr.id} (${pr.html_url})`);
  }

  /**
   * Checks/updates the status of all opened PRs when the main repository gets a push update
   * Triggered by event
   */
  // todo(OCOMBE): change it to use database trigger
  async onPush(context: probot.Context): Promise<void> {
    const config = await this.getConfig(context);
    if(!config.checks.noConflict) {
      return;
    }
    const {owner, repo} = context.repo();
    const repoId = context.payload.repository.id;
    let ref = context.payload.ref.split('/');
    ref = ref[ref.length - 1];

    const pullRequests = await this.pullRequests.where('state', '==', 'open')
      .where('base.ref', '==', ref)
      .where('repository.id', '==', repoId)
      .get();
    return await pullRequests.forEach(async doc => {
      let pr = doc.data();

      // We need to get the updated mergeable status
      // TODO(ocombe): we might need to setTimeout this until we get a mergeable value !== null (or use probot scheduler)
      pr = await this.updateDbPR(context.github, owner, repo, pr.number, repoId);

      if(pr.mergeable === false) {
        // get the comments since the last time the PR was synchronized
        if((pr.conflict_comment_at && pr.synchronized_at && pr.conflict_comment_at >= pr.synchronized_at) || (!pr.synchronized_at && pr.conflict_comment_at)) {
          this.robot.log(`The PR ${pr.html_url} already contains a merge conflict comment since the last synchronized date, skipping it`);
          return;
        }

        if(config.mergeConflictComment) {
          await context.github.issues.createComment({
            owner,
            repo,
            number: pr.number,
            body: config.mergeConflictComment.replace("{{PRAuthor}}", pr.user.login)
          });
          this.pullRequests.doc(pr.id.toString()).set({conflict_comment_at: new Date()}, {merge: true}).catch(err => {
            throw err;
          });
          this.robot.log(`Added comment to the PR ${pr.html_url}: conflict with the base branch "${pr.base.ref}"`);
        }
      }
    });
  }

  /**
   * Updates the status of a PR
   */
  private async updateStatus(context: probot.Context, updateStatus = true, updateG3Status = false, labels?: Github.Label[]): Promise<void> {
    if(context.payload.action === "synchronize") {
      updateG3Status = true;
    }
    if(!updateStatus && !updateG3Status) {
      return;
    }
    const config = await this.getConfig(context);
    if(config.status.disabled) {
      return;
    }
    let sha, url, pr;
    const {owner, repo} = context.repo();

    switch(context.event) {
      case 'pull_request':
      case 'pull_request_review':
        sha = context.payload.pull_request.head.sha;
        url = context.payload.pull_request.html_url;
        pr = context.payload.pull_request;
        if(!labels) {
          labels = await this.getLabels(context);
        }
        this.robot.log(`Update status from event ${context.event} (action: ${context.payload.action}) for PR ${url}`);
        break;
      case 'status':
        // ignore status update events that are coming from this bot
        if(context.payload.context === config.status.context) {
          this.robot.log(`Update status coming from this bot, ignored`);
          return;
        }
        // ignore status events for commits coming directly from the default branch (most likely using github edit)
        // because they are not coming from a PR (e.g. travis runs for all commits and triggers a status update)
        if(context.payload.branches.name === context.payload.repository.default_branch) {
          this.robot.log(`Update status coming directly from the default branch (${context.payload.branches.name}, ignored`);
          return;
        }
        sha = context.payload.sha;
        let matches = (await this.pullRequests.where('head.sha', '==', sha)
          .where('repository.id', '==', context.payload.repository.id)
          .get());
        matches.forEach(async doc => {
          pr = doc.data();
        });
        if(!pr) {
          // the repository data was previously stored as a simple id, checking if this PR still has old data
          matches = (await this.pullRequests.where('head.sha', '==', sha)
            .where('repository', '==', context.payload.repository.id)
            .get());
          matches.forEach(async doc => {
            pr = doc.data();
          });
        }
        // either init has not finished yet and we don't have this PR in the DB, or it's a status update for a commit
        // made directly on a branch without a PR (e.g. travis runs for all commits and triggers a status update)
        if(!pr) {
          this.robot.log(`Update status for unknown PR, ignored. Head sha == ${sha}, repository == ${context.payload.repository.id}`);
          return;
        }
        if(!labels) {
          labels = pr.labels || await getGhLabels(context.github, owner, repo, pr.number);
        }
        url = pr.html_url;
        this.robot.log(`Update status from event ${context.event} (context: ${context.payload.context}) for PR ${url}`);
        break;
      default:
        throw new Error(`Unhandled event ${context.event} in updateStatus`);
    }

    const statuses = await this.getStatuses(context, sha);

    if(updateG3Status) {
      // checking if we need to add g3 status
      const files: Github.File[] = (await context.github.pullRequests.getFiles({owner, repo, number: pr.number})).data;
      if(match(files.map(file => file.filename), config.g3Status.include, config.g3Status.exclude)) {
        // only update g3 status if a commit was just pushed, or there was no g3 status
        if(context.payload.action === "synchronize" || !statuses.some(status => status.context === config.g3Status.context)) {
          const status = (await context.github.repos.createStatus({
            owner,
            repo,
            sha: sha,
            context: config.g3Status.context,
            state: 'pending',
            description: config.g3Status.pendingDesc
          })).data;
          statuses.push(status);
          this.robot.log(`Updated g3 status to pending for the PR ${url}`);
        }
      } else {
        const status = (await context.github.repos.createStatus({
          owner,
          repo,
          sha: pr.head.sha,
          context: config.g3Status.context,
          state: 'success',
          description: config.g3Status.successDesc
        })).data;
        statuses.push(status);
        this.robot.log(`Updated g3 status to success for the PR ${url}`);
      }
    }

    if(updateStatus) {
      const statusParams: Github.ReposCreateStatusParams = {
        owner,
        repo,
        sha: sha,
        context: config.status.context,
        state: 'success'
      };

      const failedChecks = await this.getChecksStatus(context, pr, config, labels, statuses);

      if(failedChecks.failure.length > 0) {
        statusParams.state = 'failure';
        statusParams.description = failedChecks.failure.concat(failedChecks.pending).join(', ');
      } else if(failedChecks.pending.length > 0) {
        statusParams.state = 'pending';
        statusParams.description = failedChecks.pending.join(', ');
      } else {
        statusParams.state = 'success';
        statusParams.description = config.status.successText;
      }

      // Capitalize first letter
      statusParams.description = statusParams.description.replace(statusParams.description[0], statusParams.description[0].toUpperCase());

      // TODO(ocombe): add a link to a dynamic page with the complete status & some description of what's required
      if(statusParams.description.length > 140) {
        statusParams.description = statusParams.description.substring(0, 137) + '...';
      }

      await context.github.repos.createStatus(statusParams);
      this.robot.log(`Updated status to "${statusParams.state}" for the PR ${url}`);
    }
  }

  /**
   * Get all external statuses except for the one added by this bot
   */
  // TODO(ocombe): use Firebase instead
  private async getStatuses(context: probot.Context, ref: string): Promise<Github.Status[]> {
    const {owner, repo} = context.repo();
    const config = await this.getConfig(context);

    const res = await context.github.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref
    });

    return res.data.statuses.filter((status: Github.Status) => status.context !== config.status.context);
  }

  /**
   * Gets the config for the merge plugin from Github or uses default if necessary
   */
  async getConfig(context: probot.Context): Promise<MergeConfig> {
    let repositoryConfig = await context.config(CONFIG_FILE);
    if(!repositoryConfig || !repositoryConfig.merge) {
      repositoryConfig = {merge: {}};
    }
    return {...appConfig.merge, ...repositoryConfig.merge};
  }
}

interface ChecksStatus {
  pending: string[];
  failure: string[];
}
