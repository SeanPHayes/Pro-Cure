import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';

export interface AuthStackProps extends StackProps {
  cfg: StageConfig;
  /** Origins the SPA is served from (custom domain and/or CloudFront domain). */
  webOrigins: string[];
}

/**
 * Cognito user pool: email sign-in (password), optional TOTP MFA, threat protection (audit), plus
 * Entra ID (SAML) and Google federation when configured. The SPA uses the hosted UI with
 * authorization code + PKCE; identity exchanges the Cognito ID token for a Pro-Cure JWT.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  readonly hostedUiUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const prod = cfg.stage === 'prod';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `pro-cure-${cfg.stage}`,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      selfSignUpEnabled: false, // users arrive by invitation (identity.user.invited)
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
      mfa:
        cfg.auth.mfa === 'required'
          ? cognito.Mfa.REQUIRED
          : cfg.auth.mfa === 'optional'
            ? cognito.Mfa.OPTIONAL
            : cognito.Mfa.OFF,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan[cfg.auth.featurePlan],
      ...(cfg.auth.featurePlan === 'PLUS'
        ? { standardThreatProtectionMode: cognito.StandardThreatProtectionMode.AUDIT_ONLY }
        : {}),
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ---- federated identity providers (only when configured)
    const providers: cognito.UserPoolClientIdentityProvider[] = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];
    const deps: Construct[] = [];

    const saml = cfg.auth.entraSaml;
    if (saml && (saml.metadataUrl || saml.metadataXml)) {
      const providerName = saml.providerName ?? 'EntraID';
      const idp = new cognito.UserPoolIdentityProviderSaml(this, 'EntraSaml', {
        userPool: this.userPool,
        name: providerName,
        metadata: saml.metadataUrl
          ? cognito.UserPoolIdentityProviderSamlMetadata.url(saml.metadataUrl)
          : cognito.UserPoolIdentityProviderSamlMetadata.file(saml.metadataXml!),
        attributeMapping: {
          email: cognito.ProviderAttribute.other(
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
          ),
          givenName: cognito.ProviderAttribute.other(
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
          ),
          familyName: cognito.ProviderAttribute.other(
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
          ),
        },
        idpSignout: true,
      });
      providers.push(cognito.UserPoolClientIdentityProvider.custom(providerName));
      deps.push(idp);
    }

    const google = cfg.auth.google;
    if (google?.clientId) {
      const idp = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
        userPool: this.userPool,
        clientId: google.clientId,
        clientSecretValue: SecretValue.secretsManager(google.clientSecretName),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
          familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        },
      });
      providers.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
      deps.push(idp);
    }

    // ---- SPA client: public (no secret), code flow + PKCE
    const callbackUrls = [
      ...props.webOrigins.map((o) => `${o}/auth/callback`),
      ...cfg.auth.extraCallbackUrls,
    ];
    const logoutUrls = [
      ...props.webOrigins.map((o) => `${o}/login`),
      ...cfg.auth.extraCallbackUrls.map((u) => u.replace(/\/auth\/callback$/, '/login')),
    ];
    this.client = this.userPool.addClient('WebClient', {
      userPoolClientName: `pro-cure-${cfg.stage}-web`,
      generateSecret: false,
      authFlows: { userSrp: true, user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      supportedIdentityProviders: providers,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    for (const d of deps) this.client.node.addDependency(d);

    this.domain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: cfg.auth.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    this.hostedUiUrl = this.domain.baseUrl();

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
    new CfnOutput(this, 'CognitoDomainUrl', { value: this.hostedUiUrl });
    new CfnOutput(this, 'SamlEntityId', {
      value: `urn:amazon:cognito:sp:${this.userPool.userPoolId}`,
      description: 'Identifier (Entity ID) for the Entra ID enterprise app',
    });
    new CfnOutput(this, 'SamlReplyUrl', {
      value: `${this.hostedUiUrl}/saml2/idpresponse`,
      description: 'Reply URL (ACS) for the Entra ID enterprise app',
    });
  }
}
