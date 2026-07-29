package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import javax.crypto.AEADBadTagException

class ServerTrustBootstrapPolicyTest {
    private val payload = ServerTrustBootstrapPayload(
        version = 1,
        algorithm = "AES-256-GCM",
        keyDerivation = "HKDF-SHA256",
        context = ServerTrustBootstrapCrypto.CONTEXT,
        salt = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
        iv = "QEFCQ0RFRkdISUpL",
        ciphertext = (
            "27YYufcSJ5ZHcinFt8qNFanThDwO8lm1A9mTvDyc1TNRHOtV_iAp5jtNw8-NUjfqy9nTZ1V6"
                + "kmEIb9egiwBM8_DA4Jc3UYsIvgKjWMsN8MYHIIZWY1jrQCFPKToudRbVSy_G-yFDLBl6TY7FH"
                + "SOsc0k1E52HJQGXRkbw0bHVfIpBCWp533MBxiFMqE2084txyq4YFiYGGchyOtjvCf0VYtk_-2"
                + "c--kEwBcTAurWR0Z4q_JKVYdpSU-XYhPuqgirEfARimYJ7zyQq7zy7Xbo4FdY_Cnd4MVmFvuF"
                + "fss1mi-gW00utXRWa7iT2g16zO8n8waAwgp1duTTnkpuo5tlC_UnBXOk_02tWxpaoCSj-efER"
                + "682XJx9lsJDXoeUWTiUO_EPN3pOJRC_HJZFoitheVAZW6_Ww0fuM2Y76wwfQeDZR1Zr7PMrF"
                + "lAzU62um1AwH2Asb8g0D1YrgfUwMkgGJLwAjvJK-Gh6fhEjPaSPDE5FKv6wH5xqZ_AdQZHsK"
                + "LxogkDCyUMbYKjPA7iUt5jz94prAHET0-68f__xQLi85xrhTCRI7fZdUPB9K3IM-HwSSi2ZzA"
                + "77vf4fTOINKjYf_1gmPwl_jIKxkPgyP7S_hX1-L6_F7MM_e5SHEmI1LNIsE8weS8i5w1CNvP"
                + "yWXJSSS0OALiMPmDgdRDz5FO5lG_uMmrwoX-rlQBVoWfgkxzNtSDCZ2ud8rYd0__wexi8YGP"
                + "ylArobU61SIkNUe5RMmQNMBysAAAHk5xiwUb3bgN_CTZwjWDg479bmhOdGdFeKJcH-_St71EA"
                + "fGDMIBLEfcRO97brvuO0wGXA2da7K35kEbCCS6XLFHCXDzBXx8vy_A9IQOqb6duAlVGrZ_GQ"
                + "Z-Ow"
            ),
        tag = "XtXOnEsEIp7SglMOW5Ee_A",
    )

    @Test
    fun `dechiffre le vecteur produit par le serveur Node`() {
        val expected = "-----BEGIN CERTIFICATE-----\n" +
            "A".repeat(600) +
            "\n-----END CERTIFICATE-----\n"

        assertEquals(
            expected,
            ServerTrustBootstrapCrypto.decrypt(
                payload,
                "11111111-1111-4111-8111-111111111111",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            ),
        )
    }

    @Test
    fun `refuse une reponse modifiee ou une autre television`() {
        assertThrows(AEADBadTagException::class.java) {
            ServerTrustBootstrapCrypto.decrypt(
                payload.copy(tag = "AtXOnEsEIp7SglMOW5Ee_A"),
                "11111111-1111-4111-8111-111111111111",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            )
        }
        assertThrows(AEADBadTagException::class.java) {
            ServerTrustBootstrapCrypto.decrypt(
                payload,
                "22222222-2222-4222-8222-222222222222",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            )
        }
    }
}
